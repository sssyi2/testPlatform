/**
 * 执行面板：用 EventSource 订阅 /api/runs/:id/events，实时展示进度、日志、断言与截图。
 *
 * 事件生命周期：
 * - mounted  -> new EventSource，onmessage 解析 data: {json}
 * - run:end   -> 关闭事件流（并解绑）
 * - unmounted -> 关闭事件流（并解绑）
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { errorMessage } from '../api'
import { formatDuration, formatTime } from '../format'
import type { AssertionResult, CaseResult, LogLevel, RunEvent, RunSummaryStats, StepResult } from '../types'
import { ImageLightbox, Notice, StatusBadge, TypeBadge } from './ui'

type LiveLog = { seq: number; time: number; level: LogLevel; message: string; caseId?: string; stepId?: string }

type Props = {
  runId: string
  /** 运行结束（或用户返回）时回调，parent 可据此刷新列表与历史 */
  onFinished: (runId: string) => void
  onBack: () => void
}

type CaseLive = {
  caseId: string
  name: string
  type: string
  status: string
  durationMs: number
  index: number
  total: number
  result?: CaseResult
}

const EMPTY_SUMMARY: RunSummaryStats = { total: 0, passed: 0, failed: 0, error: 0, skipped: 0, durationMs: 0 }

export default function RunPanel({ runId, onFinished, onBack }: Props) {
  const [name, setName] = useState('')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [status, setStatus] = useState('running')
  const [summary, setSummary] = useState<RunSummaryStats>(EMPTY_SUMMARY)
  const [total, setTotal] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentName, setCurrentName] = useState('')
  const [cases, setCases] = useState<CaseLive[]>([])
  const [logs, setLogs] = useState<LiveLog[]>([])
  const [assertions, setAssertions] = useState<{ key: string; caseId: string; stepId: string; result: AssertionResult }[]>([])
  const [screenshots, setScreenshots] = useState<{ url: string; caseName: string; stepName: string }[]>([])
  const [streamError, setStreamError] = useState('')
  const [actionError, setActionError] = useState('')
  const [connected, setConnected] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null)

  const logBoxRef = useRef<HTMLDivElement | null>(null)
  const listBoxRef = useRef<HTMLDivElement | null>(null)
  const finishedRef = useRef(false)
  const stepNameRef = useRef<Record<string, string>>({})
  /** 已处理的帧序号：后端会在 snapshot 之后回放历史事件，用它去重避免日志刷屏。 */
  const seenSeqRef = useRef<Set<number>>(new Set())

  // 首帧：拿一次 run 基本信息（用例名称、总数）
  useEffect(() => {
    let alive = true
    api
      .getRun(runId)
      .then((run) => {
        if (!alive) return
        setName(run.name)
        setStartedAt(run.startedAt)
        setStatus(run.status)
        setSummary(run.summary ?? EMPTY_SUMMARY)
        setTotal(run.summary?.total ?? run.cases?.length ?? 0)
      })
      .catch((error) => {
        if (alive) setActionError(`读取执行信息失败：${errorMessage(error)}`)
      })
    return () => {
      alive = false
    }
  }, [runId])

  // SSE 订阅 / 关闭
  useEffect(() => {
    finishedRef.current = false
    seenSeqRef.current = new Set()
    const source = new EventSource(api.runEventsUrl(runId))
    let closed = false

    const close = () => {
      if (closed) return
      closed = true
      source.close()
      setConnected(false)
    }

    source.onopen = () => {
      setConnected(true)
      setStreamError('')
    }

    source.onerror = () => {
      setConnected(false)
      if (finishedRef.current || closed) {
        close()
        return
      }
      // 执行中：EventSource 会自动重连，这里只给用户可见的提示
      setStreamError('实时连接中断，正在自动重连…（若长时间无响应，可点「打开 HTML 报告」查看已落盘结果）')
    }

    source.onmessage = (message) => {
      // 执行已结束 / 组件已卸载：忽略迟到或重连补齐的帧，避免无意义的状态更新
      if (closed) return

      let event: RunEvent
      try {
        event = JSON.parse(message.data) as RunEvent
      } catch {
        setStreamError('收到无法解析的实时事件（已忽略该帧）')
        return
      }

      // 去重：后端在建连后会回放已广播的事件（replay: true，seq 与原始事件一致），
      // 同时 EventSource 断线重连也会重放，这里按 seq 判重，避免日志重复刷屏。
      const seq = typeof event.seq === 'number' ? event.seq : -1
      if (seq >= 0) {
        if (seenSeqRef.current.has(seq)) return
        seenSeqRef.current.add(seq)
      }

      switch (event.type) {
        case 'snapshot': {
          const snapshot = event
          setStatus(snapshot.status)
          setSummary(snapshot.summary ?? EMPTY_SUMMARY)
          setTotal(snapshot.summary?.total ?? snapshot.results?.length ?? 0)
          setCases(
            (snapshot.results ?? []).map((result, index) => ({
              caseId: result.caseId,
              name: result.name,
              type: result.type,
              status: result.status,
              durationMs: result.durationMs,
              index: index + 1,
              total: snapshot.summary?.total ?? snapshot.results.length,
              result,
            })),
          )
          if (snapshot.status !== 'running') {
            finishedRef.current = true
            close()
          }
          return
        }
        case 'run:start': {
          setName(event.run.name)
          setTotal(event.run.total)
          setStatus('running')
          return
        }
        case 'run:log': {
          setLogs((prev) => [...prev, { seq: event.seq, time: event.time, level: event.level, message: event.message }])
          return
        }
        case 'case:start': {
          setCurrentIndex(event.index)
          setCurrentName(event.name)
          setCases((prev) => {
            const next = prev.filter((item) => item.caseId !== event.caseId)
            next.push({
              caseId: event.caseId,
              name: event.name,
              type: event.caseType,
              status: 'running',
              durationMs: 0,
              index: event.index,
              total: event.total,
            })
            return next
          })
          setLogs((prev) => [
            ...prev,
            { seq: event.seq, time: event.time, level: 'info', message: `▶ 开始用例 [${event.index}/${event.total}] ${event.name}` },
          ])
          return
        }
        case 'step:start': {
          stepNameRef.current[`${event.caseId}:${event.stepId}`] = event.name
          setLogs((prev) => [...prev, { seq: event.seq, time: event.time, level: 'info', message: `  ↳ 步骤：${event.name}`, caseId: event.caseId, stepId: event.stepId }])
          return
        }
        case 'step:log': {
          setLogs((prev) => [...prev, { seq: event.seq, time: event.time, level: event.level, message: event.message, caseId: event.caseId, stepId: event.stepId }])
          return
        }
        case 'assertion': {
          setAssertions((prev) => [
            ...prev,
            { key: `${event.caseId}:${event.stepId}:${event.result.assertionId}:${prev.length}`, caseId: event.caseId, stepId: event.stepId, result: event.result },
          ])
          return
        }
        case 'step:end': {
          if (event.status !== 'passed') {
            setLogs((prev) => [
              ...prev,
              { seq: event.seq, time: event.time, level: event.status === 'error' ? 'error' : 'warn', message: `  ↳ 步骤结束（${event.status}，${formatDuration(event.durationMs)}）`, caseId: event.caseId, stepId: event.stepId },
            ])
          }
          return
        }
        case 'case:end': {
          setSummary(event.summary)
          setCases((prev) => {
            const next = prev.filter((item) => item.caseId !== event.caseId)
            next.push({
              caseId: event.caseId,
              name: event.name,
              type: event.result?.type ?? 'api',
              status: event.status,
              durationMs: event.durationMs,
              index: next.length + 1,
              total: event.summary?.total ?? total,
              result: event.result,
            })
            return next
          })
          for (const step of event.result?.steps ?? []) {
            for (const shot of step.screenshots ?? []) {
              setScreenshots((prev) => [...prev, { url: shot, caseName: event.name, stepName: step.name }])
            }
          }
          setLogs((prev) => [
            ...prev,
            {
              seq: event.seq,
              time: event.time,
              level: event.status === 'passed' ? 'info' : event.status === 'error' ? 'error' : 'warn',
              message: `■ 用例结束：${event.name} → ${event.status}（${formatDuration(event.durationMs)}）`,
            },
          ])
          return
        }
        case 'run:end': {
          finishedRef.current = true
          setStatus(event.status)
          setSummary(event.summary)
          setConnected(false)
          close()
          onFinished(runId)
          return
        }
        default:
          return
      }
    }

    return () => {
      finishedRef.current = true
      close()
    }
    // onFinished 由 App 用 useCallback 稳定；这里只在 runId 变化时重订阅
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  // 日志自动滚到底部
  useEffect(() => {
    const box = logBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [logs.length])

  // 用例列表自动滚到底部（新用例出现时）
  useEffect(() => {
    const box = listBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [cases.length])

  const running = status === 'running' || (!finishedRef.current && status !== 'passed' && status !== 'failed' && status !== 'error' && status !== 'cancelled')

  const percent = useMemo(() => {
    if (!total) return 0
    const done = cases.filter((item) => item.status !== 'running').length
    return Math.min(100, Math.round((done / total) * 100))
  }, [cases, total])

  const doCancel = async () => {
    setCancelling(true)
    setActionError('')
    try {
      const result = await api.cancelRun(runId)
      if (!result.ok) setActionError('取消失败：该执行可能已经结束')
      else setLogs((prev) => [...prev, { seq: -1, time: Date.now(), level: 'warn', message: '已发送取消请求，等待当前用例结束…' }])
    } catch (error) {
      setActionError(`取消失败：${errorMessage(error)}`)
    } finally {
      setCancelling(false)
    }
  }

  return (
    <section className="card runpanel">
      <header className="card__head">
        <div>
          <h2 className="card__title">
            执行面板
            <span className={`live-dot${connected ? ' live-dot--on' : ''}`} title={connected ? '实时连接已建立' : '实时连接已断开'} />
          </h2>
          <div className="muted">
            {name || runId}
            {startedAt ? ` · 开始于 ${formatTime(startedAt)}` : ''} · {summary.total || total} 个用例
          </div>
        </div>
        <div className="card__actions">
          <StatusBadge status={status} />
          <a className="btn btn--small" href={api.runReportUrl(runId)} target="_blank" rel="noreferrer">
            打开 HTML 报告
          </a>
          {running ? (
            <button type="button" className="btn btn--small btn--danger" onClick={() => void doCancel()} disabled={cancelling}>
              {cancelling ? '取消中…' : '取消执行'}
            </button>
          ) : (
            <button type="button" className="btn btn--small" onClick={onBack}>
              返回用例列表
            </button>
          )}
        </div>
      </header>

      {actionError ? (
        <Notice tone="error" onClose={() => setActionError('')}>
          {actionError}
        </Notice>
      ) : null}
      {streamError && running ? (
        <Notice tone="warn" onClose={() => setStreamError('')}>
          {streamError}
        </Notice>
      ) : null}

      <div className="progress">
        <div className="progress__bar">
          <div className={`progress__fill${running ? ' progress__fill--live' : ''}`} style={{ width: `${percent}%` }} />
        </div>
        <div className="progress__text">
          {running ? `进行中：第 ${Math.min(currentIndex, total || 1)} / ${total || '?'} 个用例` : '已结束'}
          {currentName && running ? ` · ${currentName}` : ''}
          <span className="progress__stats">
            <span className="stat stat--passed">通过 {summary.passed}</span>
            <span className="stat stat--failed">失败 {summary.failed}</span>
            <span className="stat stat--error">异常 {summary.error}</span>
            <span className="stat stat--skipped">跳过 {summary.skipped}</span>
            <span className="stat">总耗时 {formatDuration(summary.durationMs)}</span>
          </span>
        </div>
      </div>

      <div className="runpanel__grid">
        <div className="panel">
          <div className="panel__head">用例状态（{cases.length}/{total || cases.length}）</div>
          <div className="panel__body panel__body--list" ref={listBoxRef}>
            {cases.length === 0 ? <div className="muted">等待第一个用例开始…</div> : null}
            {cases.map((item) => {
              const tone = item.status === 'passed' ? 'passed' : item.status === 'failed' ? 'failed' : item.status === 'error' ? 'error' : item.status === 'skipped' ? 'skipped' : item.status === 'running' ? 'running' : 'unknown'
              return (
                <div className="case-live" key={item.caseId}>
                  <span className={`light light--${tone}`} aria-hidden />
                  <div className="case-live__main">
                    <div className="case-live__name" title={item.name}>
                      {item.index ? `${item.index}. ` : ''}
                      {item.name}
                    </div>
                    <div className="case-live__meta">
                      <TypeBadge type={item.type} />
                      <StatusBadge status={item.status} />
                      <span className="muted">{item.status === 'running' ? '执行中…' : formatDuration(item.durationMs)}</span>
                    </div>
                  </div>
                  {item.result?.steps ? (
                    <details className="case-live__detail">
                      <summary>步骤明细</summary>
                      <div className="detail-list">
                        {item.result.steps.map((step: StepResult, i) => (
                          <div className="detail-step" key={`${step.stepId}-${i}`}>
                            <div className="detail-step__head">
                              <StatusBadge status={step.status} />
                              <span>{step.name}</span>
                              <span className="muted">{formatDuration(step.durationMs)}</span>
                            </div>
                            {step.logs?.length ? (
                              <pre className="code-block code-block--small">{step.logs.join('\n')}</pre>
                            ) : null}
                            {step.assertions?.length ? (
                              <div className="assertion-list">
                                {step.assertions.map((assertion, ai) => (
                                  <div className={`assertion assertion--${assertion.ok ? 'pass' : 'fail'}`} key={`${assertion.assertionId}-${ai}`}>
                                    <span className={`badge badge--${assertion.ok ? 'passed' : 'failed'}`}>{assertion.ok ? 'PASS' : 'FAIL'}</span>
                                    <span className="assertion__label">{assertion.label}</span>
                                    <span className="assertion__msg">{assertion.message}</span>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {step.screenshots?.length ? (
                              <div className="shots">
                                {step.screenshots.map((shot) => (
                                  <button
                                    type="button"
                                    className="shot"
                                    key={shot}
                                    onClick={() => setZoom({ src: shot, alt: `${item.name} · ${step.name}` })}
                                  >
                                    <img src={shot} alt={`${item.name} ${step.name} 截图`} loading="lazy" />
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        <div className="panel">
          <div className="panel__head">
            实时日志（等宽字体，自动滚动）
            <span className="muted"> {logs.length} 行</span>
          </div>
          <div className="panel__body panel__body--log log-box" ref={logBoxRef}>
            {logs.length === 0 ? <div className="muted">等待日志…</div> : null}
            {logs.map((line, index) => (
              <div className={`log-line log-line--${line.level}`} key={`${line.seq}-${index}`}>
                <span className="log-line__time">{new Date(line.time).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                <span className="log-line__text">{line.message}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel__head">断言结果（{assertions.length}）</div>
        <div className="panel__body panel__body--list">
          {assertions.length === 0 ? <div className="muted">暂无断言结果（用例里还没有断言，或还没执行到断言）</div> : null}
          {[...assertions].reverse().map((item) => {
            const stepName = stepNameRef.current[`${item.caseId}:${item.stepId}`] ?? item.stepId
            const caseName = cases.find((c) => c.caseId === item.caseId)?.name ?? item.caseId
            return (
              <div className={`assertion assertion--${item.result.ok ? 'pass' : 'fail'}`} key={item.key}>
                <span className={`badge badge--${item.result.ok ? 'passed' : 'failed'}`}>{item.result.ok ? 'PASS' : 'FAIL'}</span>
                <span className="assertion__label">
                  {caseName} · {stepName} · {item.result.label}
                </span>
                <span className="assertion__msg">{item.result.message}</span>
              </div>
            )
          })}
        </div>
      </div>

      {screenshots.length ? (
        <div className="panel">
          <div className="panel__head">失败 / 步骤截图（{screenshots.length}）—— 点击放大</div>
          <div className="panel__body shots">
            {screenshots.map((shot, index) => (
              <button
                type="button"
                className="shot"
                key={`${shot.url}-${index}`}
                onClick={() => setZoom({ src: shot.url, alt: `${shot.caseName} · ${shot.stepName}` })}
              >
                <img src={shot.url} alt={`${shot.caseName} ${shot.stepName} 截图`} loading="lazy" />
                <span className="shot__caption">{shot.caseName} · {shot.stepName}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {zoom ? <ImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} /> : null}
    </section>
  )
}
