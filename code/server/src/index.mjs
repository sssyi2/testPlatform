/**
 * 平台服务入口：REST API + SSE 实时日志 + 静态前端 + 报告导出。
 *
 * 启动：node server/src/index.mjs [--port 4519] [--host 127.0.0.1]
 */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createRouter, readJsonBody, sendJson, sendText, sendFile, serveStatic, openSse, startServer } from './http.mjs'
import { CODE_ROOT, DATA_DIR, RUNS_DIR, readDb, updateDb, newId, listRuns, readRun, runSummary, saveRun, deleteRun } from './store.mjs'
import { startRun, subscribe, cancelRun, isActive, getRunHistory } from './runner.mjs'
import { renderReport } from './report.mjs'
import { ASSERTION_TYPES, ASSERTION_OPS } from './assertions.mjs'
import { browsersReady } from './runners/web.mjs'

const WEB_DIST = join(CODE_ROOT, 'web', 'dist')
const EXAMPLES_DIR = join(CODE_ROOT, 'examples')

const argPort = process.argv.indexOf('--port')
const PORT = Number(process.env.PORT ?? (argPort > -1 ? process.argv[argPort + 1] : 4519))
const HOST = process.env.HOST ?? '127.0.0.1'

// ---------------------------------------------------------------- 校验

function validateCase(input, projectId) {
  const errors = []
  if (!input || typeof input !== 'object') errors.push('用例必须是对象')
  if (!input?.name || !String(input.name).trim()) errors.push('用例名称不能为空')
  const type = input?.type === 'web' ? 'web' : 'api'
  if (!Array.isArray(input?.steps) || input.steps.length === 0) errors.push('用例至少需要一个步骤')
  for (const [i, step] of (input?.steps ?? []).entries()) {
    if (type === 'api' && !step.request?.url) errors.push(`第 ${i + 1} 步缺少请求地址(url)`)
    if (type === 'web' && !step.action?.type) errors.push(`第 ${i + 1} 步缺少页面动作(action.type)`)
  }
  if (errors.length) throw Object.assign(new Error(errors.join('；')), { statusCode: 400 })

  return {
    id: input.id ?? newId('case'),
    projectId,
    name: String(input.name).trim(),
    type,
    description: input.description ?? '',
    tags: Array.isArray(input.tags) ? input.tags : [],
    enabled: input.enabled !== false,
    // 预期失败：用于「已知缺陷」用例。失败时记为 xfail（不算执行失败），
    // 反而通过时记为 xpass（提示缺陷可能已被修复，需要更新用例）。
    expectedFailure: Boolean(input.expectedFailure),
    variables: input.variables ?? {},
    timeoutMs: Number(input.timeoutMs) || undefined,
    steps: input.steps.map((step, index) => ({
      id: step.id ?? `step-${index + 1}`,
      name: step.name ?? `步骤 ${index + 1}`,
      request: step.request,
      action: step.action,
      assertions: (step.assertions ?? []).map((a, i) => ({ id: a.id ?? `a-${index + 1}-${i + 1}`, ...a })),
      extract: step.extract ?? [],
      screenshot: Boolean(step.screenshot),
      continueOnFail: Boolean(step.continueOnFail),
    })),
  }
}

function validateProject(input) {
  if (!input?.name || !String(input.name).trim()) {
    throw Object.assign(new Error('项目名称不能为空'), { statusCode: 400 })
  }
  return {
    name: String(input.name).trim(),
    description: input.description ?? '',
    baseUrl: (input.baseUrl ?? '').trim(),
    variables: input.variables ?? {},
  }
}

// ---------------------------------------------------------------- 路由

const router = createRouter()
const api = (path) => `/api${path}`

router.get(api('/health'), async () => ({
  ok: true,
  name: 'test-platform',
  version: '0.1.0',
  time: Date.now(),
  dataDir: DATA_DIR,
  webBuilt: existsSync(join(WEB_DIST, 'index.html')),
  browsersReady: await browsersReady(),
  assertionTypes: ASSERTION_TYPES,
  assertionOps: ASSERTION_OPS,
}))

// 项目
router.get(api('/projects'), async () => {
  const db = readDb()
  return db.projects
    .map((p) => ({ ...p, caseCount: db.cases.filter((c) => c.projectId === p.id).length }))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
})

router.post(api('/projects'), async ({ req }) => {
  const body = await readJsonBody(req)
  const clean = validateProject(body)
  const now = Date.now()
  const project = { id: newId('proj'), ...clean, createdAt: now, updatedAt: now }
  await updateDb((db) => { db.projects.push(project) })
  return project
})

router.get(api('/projects/:id'), async ({ params }) => {
  const db = readDb()
  const project = db.projects.find((p) => p.id === params.id)
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  return project
})

router.patch(api('/projects/:id'), async ({ req, params }) => {
  const body = await readJsonBody(req)
  return updateDb((db) => {
    const project = db.projects.find((p) => p.id === params.id)
    if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
    Object.assign(project, validateProject({ ...project, ...body }), { updatedAt: Date.now() })
    return project
  })
})

router.delete(api('/projects/:id'), async ({ params }) => updateDb((db) => {
  const index = db.projects.findIndex((p) => p.id === params.id)
  if (index < 0) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  db.projects.splice(index, 1)
  db.cases = db.cases.filter((c) => c.projectId !== params.id)
  return { ok: true }
}))

// 用例
router.get(api('/projects/:id/cases'), async ({ params }) => {
  const db = readDb()
  return db.cases.filter((c) => c.projectId === params.id)
})

router.post(api('/projects/:id/cases'), async ({ req, params }) => {
  const body = await readJsonBody(req)
  const db = readDb()
  if (!db.projects.some((p) => p.id === params.id)) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  const testCase = { ...validateCase(body, params.id), createdAt: Date.now(), updatedAt: Date.now() }
  await updateDb((d) => { d.cases.push(testCase) })
  return testCase
})

router.get(api('/cases/:id'), async ({ params }) => {
  const testCase = readDb().cases.find((c) => c.id === params.id)
  if (!testCase) throw Object.assign(new Error('用例不存在'), { statusCode: 404 })
  return testCase
})

router.put(api('/cases/:id'), async ({ req, params }) => {
  const body = await readJsonBody(req)
  return updateDb((db) => {
    const index = db.cases.findIndex((c) => c.id === params.id)
    if (index < 0) throw Object.assign(new Error('用例不存在'), { statusCode: 404 })
    const merged = { ...validateCase({ ...db.cases[index], ...body, id: params.id }, db.cases[index].projectId), createdAt: db.cases[index].createdAt, updatedAt: Date.now() }
    db.cases[index] = merged
    return merged
  })
})

router.delete(api('/cases/:id'), async ({ params }) => updateDb((db) => {
  const index = db.cases.findIndex((c) => c.id === params.id)
  if (index < 0) throw Object.assign(new Error('用例不存在'), { statusCode: 404 })
  db.cases.splice(index, 1)
  return { ok: true }
}))

// 执行
router.post(api('/runs'), async ({ req }) => {
  const body = await readJsonBody(req)
  const run = await startRun(body)
  return { runId: run.id, run: runSummary(run) }
})

router.get(api('/runs'), async ({ url }) => {
  const projectId = url.searchParams.get('projectId') ?? undefined
  const limit = Number(url.searchParams.get('limit') ?? 50)
  return listRuns({ projectId, limit }).map(runSummary)
})

router.get(api('/runs/:id'), async ({ params }) => {
  const run = readRun(params.id)
  if (!run) throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 })
  return { ...run, active: isActive(run.id) }
})

router.delete(api('/runs/:id'), async ({ params }) => {
  if (isActive(params.id)) throw Object.assign(new Error('执行中，无法删除'), { statusCode: 400 })
  deleteRun(params.id)
  return { ok: true }
})

router.post(api('/runs/:id/cancel'), async ({ params }) => ({ ok: cancelRun(params.id) }))

// SSE 实时事件
router.get(api('/runs/:id/events'), async ({ req, res, params }) => {
  const run = readRun(params.id)
  if (!run) throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 })
  const sse = openSse(req, res)
  // 先补一帧现状，保证界面立刻有一致的基线
  sse.send({ type: 'snapshot', runId: run.id, status: run.status, summary: run.summary, results: run.results, seq: 0, time: Date.now() })
  // 再回放本次执行已广播过的事件：这样即使订阅晚于启动（POST /runs 之后才连上来），
  // 实时日志也不会丢。前端按 caseId 去重，重复回放是幂等的。
  for (const event of getRunHistory(params.id)) sse.send({ ...event, replay: true })
  const unsubscribe = subscribe(params.id, (event) => sse.send(event))
  req.on('close', unsubscribe)
  return undefined
})

// 报告
router.get(api('/runs/:id/report'), async ({ params, res }) => {
  const run = readRun(params.id)
  if (!run) throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 })
  const html = renderReport(run)
  sendText(res, 200, html, 'text/html; charset=utf-8')
  return undefined
})

router.get(api('/runs/:id/report.html'), async ({ params, res }) => {
  const run = readRun(params.id)
  if (!run) throw Object.assign(new Error('执行记录不存在'), { statusCode: 404 })
  sendText(res, 200, renderReport(run), 'text/html; charset=utf-8')
  return undefined
})

// 截图等产物
router.get(api('/artifacts/:runId/:file'), async ({ params, res }) => {
  const file = join(RUNS_DIR, params.runId, params.file)
  if (!file.startsWith(RUNS_DIR)) throw Object.assign(new Error('路径非法'), { statusCode: 403 })
  if (!(await sendFile(res, file))) throw Object.assign(new Error('产物不存在'), { statusCode: 404 })
  return undefined
})

// 导入 / 导出（用例在团队间传递、demo 一键灌数据都用它）
router.get(api('/export'), async ({ url }) => {
  const db = readDb()
  const projectId = url.searchParams.get('projectId')
  const project = db.projects.find((p) => p.id === projectId)
  if (!project) throw Object.assign(new Error('项目不存在'), { statusCode: 404 })
  return { version: 1, project: { name: project.name, description: project.description, baseUrl: project.baseUrl, variables: project.variables }, cases: db.cases.filter((c) => c.projectId === project.id) }
})

router.post(api('/import'), async ({ req }) => {
  const body = await readJsonBody(req)
  if (!body?.project?.name) throw Object.assign(new Error('导入数据缺少 project.name'), { statusCode: 400 })
  const now = Date.now()
  const project = { id: newId('proj'), ...validateProject(body.project), createdAt: now, updatedAt: now }
  const cases = (body.cases ?? []).map((c) => ({ ...validateCase(c, project.id), createdAt: now, updatedAt: now }))
  await updateDb((db) => { db.projects.push(project); db.cases.push(...cases) })
  return { project, caseCount: cases.length }
})

// 示例数据：列出可导入的示例，或一键导入
router.get(api('/examples'), async () => {
  if (!existsSync(EXAMPLES_DIR)) return []
  const { readdirSync } = await import('node:fs')
  const out = []
  for (const dir of readdirSync(EXAMPLES_DIR)) {
    const manifest = join(EXAMPLES_DIR, dir, 'cases.json')
    if (existsSync(manifest)) {
      try {
        const data = JSON.parse((await import('node:fs')).readFileSync(manifest, 'utf8'))
        out.push({ id: dir, name: data.project?.name ?? dir, caseCount: (data.cases ?? []).length, readme: data.readme ?? '' })
      } catch { /* 跳过损坏示例 */ }
    }
  }
  return out
})

router.post(api('/examples/:id/import'), async ({ params }) => {
  const manifest = join(EXAMPLES_DIR, params.id, 'cases.json')
  if (!existsSync(manifest)) throw Object.assign(new Error('示例不存在'), { statusCode: 404 })
  const { readFileSync } = await import('node:fs')
  const data = JSON.parse(readFileSync(manifest, 'utf8'))
  const now = Date.now()
  const project = { id: newId('proj'), ...validateProject(data.project), createdAt: now, updatedAt: now }
  const cases = (data.cases ?? []).map((c) => ({ ...validateCase(c, project.id), createdAt: now, updatedAt: now }))
  await updateDb((db) => { db.projects.push(project); db.cases.push(...cases) })
  return { project, caseCount: cases.length }
})

// ---------------------------------------------------------------- 启动

const server = await startServer({
  port: PORT,
  host: HOST,
  handler: async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname

    if (pathname.startsWith('/api/')) {
      const match = router.match(req.method, pathname)
      if (!match) return sendJson(res, 404, { error: `未知接口：${req.method} ${pathname}` })
      const result = await match.handler({ req, res, params: match.params, url, pathname })
      if (res.writableEnded || res.headersSent) return undefined
      return sendJson(res, 200, result)
    }

    if (existsSync(join(WEB_DIST, 'index.html'))) {
      return serveStatic(res, WEB_DIST, pathname, { spaFallback: true })
    }

    return sendText(res, 200, `<!doctype html><meta charset="utf-8"><h1>测试平台服务已启动</h1>
<p>前端尚未构建。开发模式：<code>npm run dev</code>（Vite 开发服务器）。生产模式：<code>npm run build</code> 后再启动本服务。</p>
<p>API 健康检查：<a href="/api/health">/api/health</a></p>`, 'text/html; charset=utf-8')
  },
})

console.log(`[test-platform] 服务已启动：http://${HOST}:${PORT}`)
console.log(`[test-platform] 数据目录：${DATA_DIR}`)
console.log(`[test-platform] 前端产物：${existsSync(join(WEB_DIST, 'index.html')) ? WEB_DIST : '（未构建，可用 npm run dev 开发）'}`)

const shutdown = () => {
  console.log('\n[test-platform] 正在关闭…')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
