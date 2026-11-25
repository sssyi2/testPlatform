/**
 * 执行编排：一次 run 的执行、事件广播（SSE 实时日志）、进度落盘、取消。
 */
import { readDb, saveRun, runArtifactDir, newId } from './store.mjs'
import { runApiCase } from './runners/api.mjs'
import { runWebCase, launchBrowser } from './runners/web.mjs'
import { builtinVars } from './vars.mjs'

/** runId -> Set<listener> */
const subscribers = new Map()
/** runId -> { cancelled: boolean } */
const active = new Map()
/** runId -> 已广播事件的历史（用于晚订阅者回放，消除“订阅慢于执行”的竞态） */
const history = new Map()
const HISTORY_LIMIT = 3000
const HISTORY_TTL_MS = 10 * 60 * 1000
const HISTORY_MAX_RUNS = 50

export function getRunHistory(runId) {
  return history.get(runId)?.events ?? []
}

function trimHistory() {
  while (history.size > HISTORY_MAX_RUNS) {
    const oldest = [...history.entries()].sort((a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0))[0]
    if (!oldest) break
    history.delete(oldest[0])
  }
}

export function subscribe(runId, listener) {
  if (!subscribers.has(runId)) subscribers.set(runId, new Set())
  subscribers.get(runId).add(listener)
  return () => {
    subscribers.get(runId)?.delete(listener)
    if (subscribers.get(runId)?.size === 0) subscribers.delete(runId)
  }
}

function makeEmitter(runId) {
  let seq = 0
  if (!history.has(runId)) history.set(runId, { events: [], updatedAt: Date.now() })
  const entry = history.get(runId)
  return (event) => {
    const payload = { seq: ++seq, time: Date.now(), runId, ...event }
    entry.events.push(payload)
    entry.updatedAt = Date.now()
    if (entry.events.length > HISTORY_LIMIT) entry.events.splice(0, entry.events.length - HISTORY_LIMIT)
    for (const listener of subscribers.get(runId) ?? []) {
      try {
        listener(payload)
      } catch { /* 订阅者异常不影响执行 */ }
    }
    return payload
  }
}

export function isActive(runId) {
  return active.has(runId)
}

export function cancelRun(runId) {
  const entry = active.get(runId)
  if (!entry) return false
  entry.cancelled = true
  return true
}

function summarize(results, startedAt) {
  const summary = { total: results.length, passed: 0, failed: 0, error: 0, skipped: 0, xfail: 0, xpass: 0, durationMs: Date.now() - startedAt }
  for (const r of results) {
    if (r.verdict === 'xfail') { summary.xfail++; continue }        // 预期失败：不算失败
    if (r.verdict === 'xpass') { summary.xpass++; summary.passed++; continue } // 意外通过：算通过但需提醒
    if (r.status === 'passed') summary.passed++
    else if (r.status === 'failed') summary.failed++
    else if (r.status === 'skipped') summary.skipped++
    else summary.error++
  }
  return summary
}

/** 依据「是否预期失败」给出结论标记。 */
function verdictOf(result, expectedFailure) {
  if (expectedFailure) return result.status === 'passed' ? 'xpass' : 'xfail'
  return result.status === 'passed' ? 'pass' : 'fail'
}

/**
 * 启动一次执行（后台异步跑），立即返回 runId 与初始 run 对象。
 * @param {object} params { projectId, caseIds?, tags?, variables?, name?, headless? }
 */
export async function startRun(params = {}) {
  const db = readDb()
  const project = db.projects.find((p) => p.id === params.projectId)
  if (!project) {
    const error = new Error(`项目不存在：${params.projectId}`)
    error.statusCode = 404
    throw error
  }

  let cases = db.cases.filter((c) => c.projectId === project.id)
  if (Array.isArray(params.caseIds) && params.caseIds.length) {
    const wanted = new Set(params.caseIds)
    cases = cases.filter((c) => wanted.has(c.id))
  } else {
    cases = cases.filter((c) => c.enabled !== false)
    if (Array.isArray(params.tags) && params.tags.length) {
      cases = cases.filter((c) => (c.tags ?? []).some((t) => params.tags.includes(t)))
    }
  }
  if (!cases.length) {
    const error = new Error('没有匹配到任何用例（检查用例是否启用 / 标签是否正确）')
    error.statusCode = 400
    throw error
  }

  const run = {
    id: newId('run'),
    projectId: project.id,
    projectName: project.name,
    name: params.name || `${project.name} · ${new Date().toLocaleString('zh-CN')}`,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: null,
    caseIds: cases.map((c) => c.id),
    variables: { ...(project.variables ?? {}), ...(params.variables ?? {}) },
    summary: { total: cases.length, passed: 0, failed: 0, error: 0, skipped: 0, xfail: 0, xpass: 0, durationMs: 0 },
    results: [],
  }
  saveRun(run)
  active.set(run.id, { cancelled: false })

  const emit = makeEmitter(run.id)
  emit({ type: 'run:start', run: { id: run.id, name: run.name, total: cases.length, projectId: project.id } })

  // 后台执行，不阻塞 HTTP 响应
  ;(async () => {
    let browser = null
    try {
      const needsBrowser = cases.some((c) => c.type === 'web')
      if (needsBrowser) {
        emit({ type: 'run:log', level: 'info', message: '正在启动 Chromium…' })
        browser = await launchBrowser({ headless: params.headless !== false })
      }

      for (const [index, testCase] of cases.entries()) {
        if (active.get(run.id)?.cancelled) {
          emit({ type: 'run:log', level: 'warn', message: '已请求取消，停止后续用例' })
          run.status = 'cancelled'
          break
        }
        emit({ type: 'case:start', caseId: testCase.id, name: testCase.name, caseType: testCase.type, expectedFailure: Boolean(testCase.expectedFailure), index: index + 1, total: cases.length })

        const vars = {
          ...builtinVars(),
          ...(run.variables ?? {}),
          ...(testCase.variables ?? {}),
        }
        // baseUrl 优先级：用例级 > 本次执行覆盖 > 项目配置
        vars.baseUrl = testCase.variables?.baseUrl ?? run.variables?.baseUrl ?? project.baseUrl ?? ''

        let result
        try {
          result = testCase.type === 'web'
            ? await runWebCase(testCase, { vars, baseUrl: vars.baseUrl, emit, runId: run.id, artifactDir: runArtifactDir(run.id), browser })
            : await runApiCase(testCase, { vars, baseUrl: vars.baseUrl, emit, runId: run.id, artifactDir: runArtifactDir(run.id) })
        } catch (error) {
          result = {
            caseId: testCase.id,
            name: testCase.name,
            type: testCase.type,
            tags: testCase.tags ?? [],
            status: 'error',
            durationMs: 0,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            steps: [],
            logs: [`❌ 执行异常：${error.message}`],
            screenshots: [],
            error: error.message,
          }
        }

        run.results.push(result)
        result.expectedFailure = Boolean(testCase.expectedFailure)
        result.verdict = verdictOf(result, result.expectedFailure)
        run.summary = summarize(run.results, run.startedAt)
        saveRun(run)
        emit({ type: 'case:end', caseId: testCase.id, name: testCase.name, status: result.status, verdict: result.verdict, durationMs: result.durationMs, summary: run.summary, result })
      }
    } catch (error) {
      run.status = 'error'
      run.error = error.message
      emit({ type: 'run:log', level: 'error', message: `执行中断：${error.message}` })
    } finally {
      if (browser) await browser.close().catch(() => {})
      run.finishedAt = Date.now()
      run.durationMs = run.finishedAt - run.startedAt
      run.summary = summarize(run.results, run.startedAt)
      if (run.status === 'running') {
        run.status = run.summary.failed || run.summary.error ? 'failed' : 'passed'
      }
      saveRun(run)
      active.delete(run.id)
      emit({ type: 'run:end', status: run.status, summary: run.summary, durationMs: run.durationMs })
      trimHistory()
      // 历史保留一段时间，方便晚订阅者/刷新页面后仍能回放
      setTimeout(() => {
        subscribers.get(run.id)?.clear?.()
        subscribers.delete(run.id)
        history.delete(run.id)
      }, HISTORY_TTL_MS)
    }
  })()

  return run
}
