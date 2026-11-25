/**
 * 用例列表：过滤（关键字 / 类型 / 标签）、勾选、编辑、复制、删除、运行。
 */
import { useMemo, useState } from 'react'
import { formatDuration } from '../format'
import type { TestCase } from '../types'
import { StatusBadge, TagChips, TypeBadge } from './ui'

export type CaseRunBrief = {
  status: string
  durationMs: number
  finishedAt: number | null
  runId: string
}

type Props = {
  cases: TestCase[]
  loading: boolean
  /** caseId -> 最近一次执行结果 */
  latestBrief: Record<string, CaseRunBrief>
  busy: boolean
  onNew: () => void
  onEdit: (testCase: TestCase) => void
  onDuplicate: (testCase: TestCase) => void
  onDelete: (testCase: TestCase) => void
  onToggleEnabled: (testCase: TestCase, enabled: boolean) => void
  onRun: (caseIds: string[], mode: 'selected' | 'all') => void
  onRefresh: () => void
}

export default function CaseList({
  cases,
  loading,
  latestBrief,
  busy,
  onNew,
  onEdit,
  onDuplicate,
  onDelete,
  onToggleEnabled,
  onRun,
  onRefresh,
}: Props) {
  const [keyword, setKeyword] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'api' | 'web'>('all')
  const [tagFilter, setTagFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'passed' | 'failed' | 'error' | 'none'>('all')
  const [selected, setSelected] = useState<string[]>([])

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const testCase of cases) for (const tag of testCase.tags ?? []) set.add(tag)
    return [...set].sort()
  }, [cases])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return cases.filter((testCase) => {
      if (typeFilter !== 'all' && testCase.type !== typeFilter) return false
      if (tagFilter && !(testCase.tags ?? []).includes(tagFilter)) return false
      if (statusFilter !== 'all') {
        const brief = latestBrief[testCase.id]
        if (statusFilter === 'none' && brief) return false
        if (statusFilter !== 'none' && (!brief || brief.status !== statusFilter)) return false
      }
      if (!kw) return true
      const haystack = `${testCase.name} ${testCase.description ?? ''} ${(testCase.tags ?? []).join(' ')}`.toLowerCase()
      return haystack.includes(kw)
    })
  }, [cases, keyword, typeFilter, tagFilter, statusFilter, latestBrief])

  const selectedInView = filtered.filter((c) => selected.includes(c.id)).map((c) => c.id)
  const enabledInView = filtered.filter((c) => c.enabled !== false)

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const allChecked = filtered.length > 0 && selectedInView.length === filtered.length

  return (
    <section className="card">
      <header className="card__head">
        <h2 className="card__title">
          用例列表 <span className="muted">（{cases.length}）</span>
        </h2>
        <div className="card__actions">
          <button type="button" className="btn" onClick={onRefresh} disabled={busy}>
            刷新
          </button>
          <button type="button" className="btn btn--primary" onClick={onNew} disabled={busy}>
            + 新建用例
          </button>
        </div>
      </header>

      <div className="toolbar">
        <input
          className="input toolbar__search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="按名称 / 描述 / 标签搜索…"
        />
        <select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as 'all' | 'api' | 'web')}>
          <option value="all">全部类型</option>
          <option value="api">API</option>
          <option value="web">Web</option>
        </select>
        <select className="input" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
          <option value="">全部标签</option>
          {allTags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select
          className="input"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'passed' | 'failed' | 'error' | 'none')}
        >
          <option value="all">全部结果</option>
          <option value="passed">最近通过</option>
          <option value="failed">最近失败</option>
          <option value="error">最近异常</option>
          <option value="none">从未执行</option>
        </select>
        <div className="toolbar__spacer" />
        <button
          type="button"
          className="btn btn--small"
          disabled={busy || selected.length === 0}
          onClick={() => onRun(selected, 'selected')}
        >
          运行选中（{selected.length}）
        </button>
        <button
          type="button"
          className="btn btn--small btn--primary"
          disabled={busy || enabledInView.length === 0}
          onClick={() => onRun(enabledInView.map((c) => c.id), 'all')}
        >
          运行全部启用（{enabledInView.length}）
        </button>
      </div>

      {loading ? <div className="muted">正在加载用例…</div> : null}

      {!loading && cases.length === 0 ? (
        <div className="empty">
          <p className="empty__title">这个项目还没有用例</p>
          <p className="empty__text">
            点右上角「新建用例」编写第一条用例；也可以从左侧「导入示例」一键导入示例项目体验完整流程。
          </p>
          <button type="button" className="btn btn--primary" onClick={onNew}>
            + 新建用例
          </button>
        </div>
      ) : null}

      {!loading && cases.length > 0 && filtered.length === 0 ? (
        <div className="empty">
          <p className="empty__title">没有匹配的用例</p>
          <p className="empty__text">调整关键字 / 类型 / 标签 / 结果过滤条件试试。</p>
        </div>
      ) : null}

      {filtered.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="table__check">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    aria-label="全选"
                    onChange={() => setSelected(allChecked ? [] : filtered.map((c) => c.id))}
                  />
                </th>
                <th>名称</th>
                <th>类型</th>
                <th>标签</th>
                <th>步骤</th>
                <th>启用</th>
                <th>最近结果</th>
                <th className="table__ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((testCase) => {
                const brief = latestBrief[testCase.id]
                return (
                  <tr key={testCase.id} className={selected.includes(testCase.id) ? 'row--selected' : undefined}>
                    <td className="table__check">
                      <input
                        type="checkbox"
                        checked={selected.includes(testCase.id)}
                        aria-label={`选择 ${testCase.name}`}
                        onChange={() => toggle(testCase.id)}
                      />
                    </td>
                    <td>
                      <div className="cell-title">{testCase.name}</div>
                      {testCase.description ? <div className="cell-sub">{testCase.description}</div> : null}
                    </td>
                    <td>
                      <TypeBadge type={testCase.type} />
                    </td>
                    <td>
                      <TagChips tags={testCase.tags} />
                    </td>
                    <td className="muted">{testCase.steps?.length ?? 0}</td>
                    <td>
                      <label className="switch" title={testCase.enabled === false ? '已停用' : '已启用'}>
                        <input
                          type="checkbox"
                          checked={testCase.enabled !== false}
                          onChange={(e) => onToggleEnabled(testCase, e.target.checked)}
                          disabled={busy}
                        />
                        <span className="switch__slider" />
                      </label>
                    </td>
                    <td>
                      {brief ? (
                        <span className="cell-status">
                          <StatusBadge status={brief.status} />
                          <span className="muted">{formatDuration(brief.durationMs)}</span>
                        </span>
                      ) : (
                        <span className="muted">未执行</span>
                      )}
                    </td>
                    <td className="table__ops">
                      <button type="button" className="btn btn--small" onClick={() => onRun([testCase.id], 'selected')} disabled={busy}>
                        运行
                      </button>
                      <button type="button" className="btn btn--small" onClick={() => onEdit(testCase)} disabled={busy}>
                        编辑
                      </button>
                      <button type="button" className="btn btn--small" onClick={() => onDuplicate(testCase)} disabled={busy}>
                        复制
                      </button>
                      <button
                        type="button"
                        className="btn btn--small btn--danger"
                        onClick={() => onDelete(testCase)}
                        disabled={busy}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
