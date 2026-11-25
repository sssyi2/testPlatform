/**
 * 执行记录（历史）视图：历史列表 + 单次执行明细（用例级折叠步骤、请求/响应、断言、截图）。
 */
import { useEffect, useState } from 'react'
import * as api from '../api'
import { errorMessage } from '../api'
import { formatDuration, formatTime, truncate } from '../format'
import type { CaseResult, Run, RunSummary, StepResult } from '../types'
import { ConfirmDialog, ImageLightbox, Notice, StatusBadge, TypeBadge } from './ui'

type Props = {
  projectId: string
  runs: RunSummary[]
  loading: boolean
  onRefresh: () => void
  /** 查看正在执行中的 run（跳到执行面板） */
  onOpenLive: (runId: string) => void
}

/** 单步明细：请求 / 响应 / 断言 / 抽取 / 截图。 */
function StepResultView({
  step,
  onZoom,
}: {
  step: StepResult
  onZoom: (src: string, alt: string) => void
}) {
  const [showRawHeaders, setShowRawHeaders] = useState(false)
  return (
    <div className="detail-step">
      <div className="detail-step__head">
        <StatusBadge status={step.status} />
        <span className="detail-step__name">{step.name}</span>
        <span className="muted">{formatDuration(step.durationMs)}</span>
      </div>

      {step.request ? (
        <div className="kv-view">
          <div className="kv-view__row">
            <span className="kv-view__key">请求</span>
            <code className="mono">
              {step.request.method} {step.request.url}
            </code>
          </div>
          {step.request.headers && Object.keys(step.request.headers).length ? (
            <div className="kv-view__row">
              <span className="kv-view__key">请求头</span>
              <code className="mono">{Object.entries(step.request.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</code>
            </div>
          ) : null}
          {step.request.body ? (
            <div className="kv-view__row">
              <span className="kv-view__key">请求体</span>
              <pre className="code-block code-block--small">{truncate(step.request.body, 2000)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {step.response ? (
        <div className="kv-view">
          <div className="kv-view__row">
            <span className="kv-view__key">响应</span>
            <code className="mono">
              HTTP {step.response.status} · {step.response.bodySize} 字节
              {step.response.truncated ? '（已截断）' : ''}
            </code>
          </div>
          <div className="kv-view__row">
            <span className="kv-view__key">
              响应头
              <button type="button" className="link-btn" onClick={() => setShowRawHeaders((v) => !v)}>
                {showRawHeaders ? '收起' : '展开'}
              </button>
            </span>
            {showRawHeaders ? (
              <code className="mono">
                {Object.entries(step.response.headers ?? {})
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n')}
              </code>
            ) : (
              <span className="muted">
                {Object.keys(step.response.headers ?? {}).length} 个响应头
              </span>
            )}
          </div>
          {step.response.bodyPreview ? (
            <div className="kv-view__row">
              <span className="kv-view__key">响应体</span>
              <pre className="code-block code-block--small">{truncate(step.response.bodyPreview, 4000)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {step.error ? <Notice tone="error">错误：{step.error}</Notice> : null}

      {step.extracted && Object.keys(step.extracted).length ? (
        <div className="kv-view">
          <div className="kv-view__row">
            <span className="kv-view__key">抽取变量</span>
            <code className="mono">
              {Object.entries(step.extracted)
                .map(([k, v]) => `${k} = ${truncate(v, 200)}`)
                .join('\n')}
            </code>
          </div>
        </div>
      ) : null}

      {step.pageUrl ? (
        <div className="kv-view">
          <div className="kv-view__row">
            <span className="kv-view__key">页面地址</span>
            <code className="mono">{step.pageUrl}</code>
          </div>
        </div>
      ) : null}

      {step.assertions?.length ? (
        <div className="assertion-list">
          {step.assertions.map((assertion, index) => (
            <div className={`assertion assertion--${assertion.ok ? 'pass' : 'fail'}`} key={`${assertion.assertionId}-${index}`}>
              <span className={`badge badge--${assertion.ok ? 'passed' : 'failed'}`}>{assertion.ok ? 'PASS' : 'FAIL'}</span>
              <span className="assertion__label">{assertion.label}</span>
              <span className="assertion__msg">
                {assertion.message}
                <span className="muted">
                  {' '}
                  （期望 {truncate(String(assertion.expected), 120)} / 实际 {truncate(String(assertion.actual), 120)}）
                </span>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {step.logs?.length ? <pre className="code-block code-block--small">{step.logs.join('\n')}</pre> : null}

      {step.screenshots?.length ? (
        <div className="shots">
          {step.screenshots.map((shot, index) => (
            <button type="button" className="shot" key={`${shot}-${index}`} onClick={() => onZoom(shot, step.name)}>
              <img src={shot} alt={`${step.name} 截图`} loading="lazy" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 单次执行明细。 */
function RunDetail({ runId, onDeleted, onBack }: { runId: string; onDeleted: () => void; onBack: () => void }) {
  const [run, setRun] = useState<Run | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null)
  const [openCases, setOpenCases] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    api
      .getRun(runId)
      .then((data) => {
        if (!alive) return
        setRun(data)
        // 默认展开失败/异常的用例
        setOpenCases((data.results ?? []).filter((r) => r.status !== 'passed').map((r) => r.caseId))
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [runId])

  const doDelete = async () => {
    setDeleting(true)
    setError('')
    try {
      await api.deleteRun(runId)
      setConfirmDelete(false)
      onDeleted()
    } catch (err) {
      setError(errorMessage(err))
      setConfirmDelete(false)
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <div className="muted pad">正在加载执行明细…</div>
  if (error) {
    return (
      <div className="pad">
        <Notice tone="error">{error}</Notice>
        <button type="button" className="btn" onClick={onBack}>
          返回历史列表
        </button>
      </div>
    )
  }
  if (!run) return null

  const toggleCase = (caseId: string) =>
    setOpenCases((prev) => (prev.includes(caseId) ? prev.filter((x) => x !== caseId) : [...prev, caseId]))

  return (
    <section className="card">
      <header className="card__head">
        <div>
          <h2 className="card__title">
            <button type="button" className="link-btn" onClick={onBack}>
              ← 执行记录
            </button>
            <span className="card__title-sep">/</span>
            {run.name}
          </h2>
          <div className="muted">
            {formatTime(run.startedAt)} · 耗时 {formatDuration(run.durationMs ?? run.summary?.durationMs)} ·{' '}
            {run.summary?.total ?? 0} 个用例
            {run.active ? ' · 仍在执行中' : ''}
          </div>
        </div>
        <div className="card__actions">
          <StatusBadge status={run.status} />
          <a className="btn btn--small" href={api.runReportUrl(runId)} target="_blank" rel="noreferrer">
            打开 HTML 报告
          </a>
          <button type="button" className="btn btn--small btn--danger" onClick={() => setConfirmDelete(true)} disabled={run.active}>
            删除记录
          </button>
        </div>
      </header>

      {error ? <Notice tone="error" onClose={() => setError('')}>{error}</Notice> : null}

      <div className="progress__stats pad-x">
        <span className="stat stat--passed">通过 {run.summary?.passed ?? 0}</span>
        <span className="stat stat--failed">失败 {run.summary?.failed ?? 0}</span>
        <span className="stat stat--error">异常 {run.summary?.error ?? 0}</span>
        <span className="stat stat--skipped">跳过 {run.summary?.skipped ?? 0}</span>
      </div>

      {run.error ? <Notice tone="error">执行中断：{run.error}</Notice> : null}

      {(run.results ?? []).length === 0 ? <div className="muted pad-x">这次执行没有产生用例结果。</div> : null}

      <div className="case-results">
        {(run.results ?? []).map((result: CaseResult) => {
          const open = openCases.includes(result.caseId)
          const failedAssertions = (result.steps ?? []).flatMap((s) => s.assertions ?? []).filter((a) => !a.ok)
          return (
            <div className={`case-result${open ? ' case-result--open' : ''}`} key={result.caseId}>
              <button type="button" className="case-result__head" onClick={() => toggleCase(result.caseId)}>
                <span className="case-result__caret">{open ? '▾' : '▸'}</span>
                <span className="case-result__name">{result.name}</span>
                <TypeBadge type={result.type} />
                <StatusBadge status={result.status} />
                <span className="muted">
                  {formatDuration(result.durationMs)} · {result.steps?.length ?? 0} 步
                  {failedAssertions.length ? ` · ${failedAssertions.length} 条断言失败` : ''}
                </span>
              </button>
              {open ? (
                <div className="case-result__body">
                  {result.error ? <Notice tone="error">用例异常：{result.error}</Notice> : null}
                  {result.logs?.length ? <pre className="code-block code-block--small">{result.logs.join('\n')}</pre> : null}
                  {(result.steps ?? []).map((step, index) => (
                    <StepResultView step={step} key={`${step.stepId}-${index}`} onZoom={(src, alt) => setZoom({ src, alt })} />
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          title="删除执行记录"
          busy={deleting}
          message={<>确定删除这次执行记录「{run.name}」吗？记录与截图会被一并删除，不可撤销。</>}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void doDelete()}
        />
      ) : null}

      {zoom ? <ImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} /> : null}
    </section>
  )
}

export default function HistoryView({ projectId, runs, loading, onRefresh, onOpenLive }: Props) {
  const [detailId, setDetailId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<RunSummary | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  if (detailId) {
    return (
      <RunDetail
        runId={detailId}
        onBack={() => setDetailId(null)}
        onDeleted={() => {
          setDetailId(null)
          onRefresh()
        }}
      />
    )
  }

  const doDelete = async () => {
    if (!confirmDelete) return
    setDeleting(true)
    setError('')
    try {
      await api.deleteRun(confirmDelete.id)
      setConfirmDelete(null)
      onRefresh()
    } catch (err) {
      setError(errorMessage(err))
      setConfirmDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <section className="card">
      <header className="card__head">
        <h2 className="card__title">执行记录</h2>
        <div className="card__actions">
          <button type="button" className="btn btn--small" onClick={onRefresh} disabled={loading}>
            刷新
          </button>
        </div>
      </header>

      {error ? <Notice tone="error" onClose={() => setError('')}>{error}</Notice> : null}

      {loading ? <div className="muted">正在加载执行记录…</div> : null}

      {!loading && runs.length === 0 ? (
        <div className="empty">
          <p className="empty__title">还没有执行记录</p>
          <p className="empty__text">
            {projectId ? '回到「用例列表」勾选用例并点「运行选中」，这里就会出现历史记录与报告入口。' : '先在左侧选择或新建一个项目。'}
          </p>
        </div>
      ) : null}

      {runs.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>开始时间</th>
                <th>名称</th>
                <th>用例数</th>
                <th>通过 / 失败 / 异常 / 跳过</th>
                <th>耗时</th>
                <th>状态</th>
                <th className="table__ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td className="nowrap">{formatTime(run.startedAt)}</td>
                  <td>
                    <button type="button" className="link-btn" onClick={() => setDetailId(run.id)}>
                      {run.name}
                    </button>
                  </td>
                  <td>{run.summary?.total ?? run.cases?.length ?? 0}</td>
                  <td>
                    <span className="stat stat--passed">{run.summary?.passed ?? 0}</span> /{' '}
                    <span className="stat stat--failed">{run.summary?.failed ?? 0}</span> /{' '}
                    <span className="stat stat--error">{run.summary?.error ?? 0}</span> /{' '}
                    <span className="stat stat--skipped">{run.summary?.skipped ?? 0}</span>
                  </td>
                  <td>{formatDuration(run.durationMs ?? run.summary?.durationMs)}</td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="table__ops">
                    <button type="button" className="btn btn--small" onClick={() => setDetailId(run.id)}>
                      明细
                    </button>
                    <a className="btn btn--small" href={api.runReportUrl(run.id)} target="_blank" rel="noreferrer">
                      报告
                    </a>
                    {run.status === 'running' ? (
                      <button type="button" className="btn btn--small" onClick={() => onOpenLive(run.id)}>
                        实时
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--small btn--danger"
                      onClick={() => setConfirmDelete(run)}
                      disabled={run.status === 'running'}
                      title={run.status === 'running' ? '执行中无法删除' : '删除记录'}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          title="删除执行记录"
          busy={deleting}
          message={<>确定删除执行记录「{confirmDelete.name}」吗？记录与截图会被一并删除，不可撤销。</>}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void doDelete()}
        />
      ) : null}
    </section>
  )
}
