/**
 * 测试平台主界面：顶部标题栏 + 左侧项目栏 + 右侧主区域（用例列表 / 用例编辑 / 执行面板 / 执行记录）。
 * 不使用路由库，用 useState 管理当前视图。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from './api'
import { errorMessage } from './api'
import CaseEditor from './components/CaseEditor'
import CaseList from './components/CaseList'
import HistoryView from './components/HistoryView'
import ProjectBar from './components/ProjectBar'
import RunPanel from './components/RunPanel'
import { ConfirmDialog, Notice } from './components/ui'
import { formatDuration } from './format'
import type { AssertionTypeMeta, Health, Project, RunSummary, TestCase } from './types'
import type { CaseRunBrief } from './components/CaseList'

type View = 'cases' | 'run' | 'history'

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [healthError, setHealthError] = useState('')

  const [projects, setProjects] = useState<Project[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)

  const [cases, setCases] = useState<TestCase[]>([])
  const [casesLoading, setCasesLoading] = useState(false)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [runsLoading, setRunsLoading] = useState(false)

  const [view, setView] = useState<View>('cases')
  const [editing, setEditing] = useState<TestCase | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const [globalError, setGlobalError] = useState('')
  const [toast, setToast] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<TestCase | null>(null)

  // ------------------------------------------------------------ 健康检查（断言类型下拉框数据源）
  const loadHealth = useCallback(async () => {
    try {
      const data = await api.getHealth()
      setHealth(data)
      setHealthError('')
    } catch (error) {
      setHealth(null)
      setHealthError(errorMessage(error))
    }
  }, [])

  useEffect(() => {
    void loadHealth()
    // 后端可能比前端晚启动，30s 轮询一次；点状态徽标也可手动重试
    const timer = window.setInterval(() => void loadHealth(), 30000)
    return () => window.clearInterval(timer)
  }, [loadHealth])

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(''), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  // ------------------------------------------------------------ 项目
  const loadProjects = useCallback(
    async (selectId?: string) => {
      setProjectsLoading(true)
      try {
        const list = await api.listProjects()
        setProjects(list)
        setCurrentProjectId((prev) => {
          const wanted = selectId ?? prev
          if (wanted && list.some((p) => p.id === wanted)) return wanted
          return list[0]?.id ?? null
        })
      } catch (error) {
        setGlobalError(`加载项目失败：${errorMessage(error)}`)
      } finally {
        setProjectsLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  // ------------------------------------------------------------ 当前项目的用例 + 执行记录
  const currentProject = useMemo(
    () => projects.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  )

  const loadCases = useCallback(async (projectId: string, silent = false) => {
    if (!silent) setCasesLoading(true)
    try {
      const list = await api.listCases(projectId)
      setCases(list)
    } catch (error) {
      setGlobalError(`加载用例失败：${errorMessage(error)}`)
    } finally {
      if (!silent) setCasesLoading(false)
    }
  }, [])

  const loadRuns = useCallback(async (projectId: string, silent = false) => {
    if (!silent) setRunsLoading(true)
    try {
      const list = await api.listRuns(projectId, 50)
      setRuns(list)
    } catch (error) {
      setGlobalError(`加载执行记录失败：${errorMessage(error)}`)
    } finally {
      if (!silent) setRunsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!currentProjectId) {
      setCases([])
      setRuns([])
      setEditorOpen(false)
      setEditing(null)
      return
    }
    setEditorOpen(false)
    setEditing(null)
    setActiveRunId(null)
    setView('cases')
    void loadCases(currentProjectId)
    void loadRuns(currentProjectId)
  }, [currentProjectId, loadCases, loadRuns])

  /** caseId -> 最近一次执行结果（取历史里第一条命中的记录）。 */
  const latestBrief = useMemo(() => {
    const map: Record<string, CaseRunBrief> = {}
    for (const run of runs) {
      for (const item of run.cases ?? []) {
        if (!map[item.caseId]) {
          map[item.caseId] = {
            status: item.status,
            durationMs: item.durationMs,
            finishedAt: run.finishedAt,
            runId: run.id,
          }
        }
      }
    }
    return map
  }, [runs])

  const assertionTypes: Record<string, AssertionTypeMeta> = health?.assertionTypes ?? {}
  const assertionOps = health?.assertionOps ?? {}

  // ------------------------------------------------------------ 用例操作
  const handleToggleEnabled = async (testCase: TestCase, enabled: boolean) => {
    setBusy(true)
    setGlobalError('')
    try {
      const updated = await api.updateCase(testCase.id, { ...testCase, enabled })
      setCases((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
    } catch (error) {
      setGlobalError(`切换启用状态失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDuplicate = async (testCase: TestCase) => {
    setBusy(true)
    setGlobalError('')
    try {
      const copy = await api.createCase(testCase.projectId, {
        ...testCase,
        id: undefined,
        name: `${testCase.name} - 副本`,
      })
      await loadCases(testCase.projectId, true)
      setToast(`已复制用例「${copy.name}」`)
    } catch (error) {
      setGlobalError(`复制用例失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteCase = async () => {
    if (!pendingDelete) return
    setBusy(true)
    setGlobalError('')
    try {
      await api.deleteCase(pendingDelete.id)
      setPendingDelete(null)
      await loadCases(pendingDelete.projectId, true)
      setToast('用例已删除')
    } catch (error) {
      setGlobalError(`删除用例失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  // ------------------------------------------------------------ 运行
  const handleRun = async (caseIds: string[], mode: 'selected' | 'all') => {
    if (!currentProjectId) return
    if (caseIds.length === 0) {
      setGlobalError('请先勾选要运行的用例')
      return
    }
    setBusy(true)
    setGlobalError('')
    try {
      const result = await api.startRun({
        projectId: currentProjectId,
        caseIds,
        name: `${currentProject?.name ?? '项目'} · ${mode === 'all' ? '全部启用' : `${caseIds.length} 个用例`}`,
      })
      setActiveRunId(result.runId)
      setView('run')
      setToast('已开始执行，正在实时推送日志…')
      void loadRuns(currentProjectId, true)
    } catch (error) {
      setGlobalError(`启动执行失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  /** 执行结束：刷新历史与用例最近结果。 */
  const handleRunFinished = useCallback(
    (_runId: string) => {
      setToast('执行已结束，可查看明细与报告')
      if (currentProjectId) {
        void loadRuns(currentProjectId, true)
        void loadCases(currentProjectId, true)
      }
    },
    [currentProjectId, loadCases, loadRuns],
  )

  // ------------------------------------------------------------ 渲染
  const apiOnline = Boolean(health?.ok)

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__logo">测</span>
          <div>
            <div className="topbar__title">测试平台</div>
            <div className="topbar__sub">通用软件测试平台 · API 与 Web UI 用例</div>
          </div>
        </div>
        <div className="topbar__health">
          <button
            type="button"
            className={`health health--${apiOnline ? 'ok' : 'bad'}`}
            onClick={() => void loadHealth()}
            title="点击重新检查后端状态"
          >
            <span className={`dot dot--${apiOnline ? 'ok' : 'bad'}`} />
            {apiOnline ? `API 在线 · v${health?.version}` : 'API 离线'}
          </button>
          <span
            className={`health health--${health?.browsersReady ? 'ok' : 'warn'}`}
            title={health?.browsersReady ? 'Chromium 已就绪，可运行 Web 用例' : 'Chromium 未就绪：请在后端执行 npm run install:browsers'}
          >
            <span className={`dot dot--${health?.browsersReady ? 'ok' : 'warn'}`} />
            {health?.browsersReady ? 'Chromium 就绪' : 'Chromium 未就绪'}
          </span>
          {health ? <span className="health health--plain">数据目录 {health.dataDir}</span> : null}
        </div>
      </header>

      <div className="layout">
        <ProjectBar
          projects={projects}
          currentId={currentProjectId}
          loading={projectsLoading}
          onSelect={setCurrentProjectId}
          onRefresh={(selectId) => void loadProjects(selectId)}
        />

        <main className="main">
          {globalError ? (
            <Notice tone="error" onClose={() => setGlobalError('')}>
              {globalError}
            </Notice>
          ) : null}
          {toast ? (
            <Notice tone="success" onClose={() => setToast('')}>
              {toast}
            </Notice>
          ) : null}
          {!apiOnline && healthError ? (
            <Notice tone="warn">
              后端接口不可用：{healthError} 请确认已启动服务（<code>npm start</code>，默认 http://127.0.0.1:4519
              ），或开发模式下用 <code>npm run dev</code>。
            </Notice>
          ) : null}

          {view !== 'run' ? (
            <nav className="tabs">
              <button
                type="button"
                className={`tab${view === 'cases' && !editorOpen ? ' tab--active' : ''}`}
                onClick={() => {
                  setEditorOpen(false)
                  setView('cases')
                }}
              >
                用例列表
              </button>
              <button
                type="button"
                className={`tab${view === 'history' ? ' tab--active' : ''}`}
                onClick={() => {
                  setEditorOpen(false)
                  setView('history')
                }}
              >
                执行记录 {runs.length ? `(${runs.length})` : ''}
              </button>
              {activeRunId ? (
                <button type="button" className="tab" onClick={() => setView('run')}>
                  执行面板
                </button>
              ) : null}
              {currentProject ? (
                <span className="tabs__project">
                  当前项目：<b>{currentProject.name}</b>
                  {currentProject.baseUrl ? <code className="mono"> {currentProject.baseUrl}</code> : null}
                </span>
              ) : null}
            </nav>
          ) : null}

          {!currentProject ? (
            <section className="card">
              <div className="empty">
                <p className="empty__title">还没有选择项目</p>
                <p className="empty__text">
                  从左侧「导入示例」一键体验完整流程（内置示例项目 + 用例 + 报告），或点「新建」创建你自己的项目。
                </p>
              </div>
            </section>
          ) : null}

          {currentProject && editorOpen ? (
            <CaseEditor
              projectId={currentProject.id}
              editing={editing}
              assertionTypes={assertionTypes}
              assertionOps={assertionOps}
              onCancel={() => {
                setEditorOpen(false)
                setEditing(null)
              }}
              onSaved={(saved, created) => {
                setEditorOpen(false)
                setEditing(null)
                setView('cases')
                setToast(created ? `用例「${saved.name}」已创建` : `用例「${saved.name}」已保存`)
                void loadCases(currentProject.id, true)
              }}
            />
          ) : null}

          {currentProject && !editorOpen && view === 'cases' ? (
            <CaseList
              cases={cases}
              loading={casesLoading}
              latestBrief={latestBrief}
              busy={busy}
              onNew={() => {
                setEditing(null)
                setEditorOpen(true)
              }}
              onEdit={(testCase) => {
                setEditing(testCase)
                setEditorOpen(true)
              }}
              onDuplicate={(testCase) => void handleDuplicate(testCase)}
              onDelete={(testCase) => setPendingDelete(testCase)}
              onToggleEnabled={(testCase, enabled) => void handleToggleEnabled(testCase, enabled)}
              onRun={(caseIds, mode) => void handleRun(caseIds, mode)}
              onRefresh={() => {
                void loadCases(currentProject.id)
                void loadRuns(currentProject.id, true)
              }}
            />
          ) : null}

          {currentProject && view === 'run' && activeRunId ? (
            <RunPanel
              runId={activeRunId}
              onFinished={handleRunFinished}
              onBack={() => {
                setView('cases')
                setActiveRunId(null)
              }}
            />
          ) : null}

          {currentProject && !editorOpen && view === 'history' ? (
            <HistoryView
              projectId={currentProject.id}
              runs={runs}
              loading={runsLoading}
              onRefresh={() => void loadRuns(currentProject.id)}
              onOpenLive={(runId) => {
                setActiveRunId(runId)
                setView('run')
              }}
            />
          ) : null}
        </main>
      </div>

      <footer className="footer">
        <span>
          后端 <code>/api</code> · 共 {projects.length} 个项目 / {cases.length} 个用例 / {runs.length} 条执行记录
        </span>
        {runs[0] ? (
          <span className="muted">
            最近一次执行：{runs[0].name}（{formatDuration(runs[0].durationMs ?? runs[0].summary?.durationMs)}）
          </span>
        ) : null}
      </footer>

      {pendingDelete ? (
        <ConfirmDialog
          title="删除用例"
          busy={busy}
          message={
            <>
              确定删除用例「<b>{pendingDelete.name}</b>」吗？操作不可撤销。
            </>
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void handleDeleteCase()}
        />
      ) : null}
    </div>
  )
}
