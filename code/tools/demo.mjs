#!/usr/bin/env node
/**
 * 一键演示：启动示例被测软件 + 平台服务 + 导入示例用例 + 执行 + 打印结果与报告地址。
 *
 * 用法：
 *   node tools/demo.mjs            # 跑完保持运行，便于打开界面查看
 *   node tools/demo.mjs --open     # 跑完自动打开报告页面
 *   node tools/demo.mjs --once     # 跑完打印结论后退出（适合做命令行的自动化验证）
 *   node tools/demo.mjs --serve    # 只启动环境（不自动执行），并打开平台界面 —— 录屏演示用
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM_PORT = Number(process.env.PLATFORM_PORT ?? 4519)
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 4517)
const PLATFORM = `http://127.0.0.1:${PLATFORM_PORT}`
const ONCE = process.argv.includes('--once')
const OPEN = process.argv.includes('--open') || process.argv.includes('--serve')
const SERVE = process.argv.includes('--serve')

const children = []
function shutdown(code = 0) {
  for (const child of children) if (!child.killed) child.kill()
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function startServer(label, script, env) {
  const child = spawn(process.execPath, [script], { cwd: CODE_ROOT, stdio: 'inherit', env: { ...process.env, ...env } })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[demo] ${label} 异常退出：code=${code}`)
  })
  children.push(child)
  return child
}

async function waitFor(url, { timeoutMs = 20000, label = url } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json().catch(() => ({}))
    } catch { /* 还没起来 */ }
    await delay(300)
  }
  throw new Error(`等待 ${label} 就绪超时`)
}

const STATUS_ICON = { passed: '✅', failed: '❌', error: '💥', skipped: '⏭️', running: '⏳' }

/** 用系统默认浏览器打开地址（不阻塞）。 */
function openBrowser(url) {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  } catch (error) {
    console.log(`[demo] 打开浏览器失败（可手动访问）：${url}（${error.message}）`)
  }
}

async function streamRun(runId) {
  const res = await fetch(`${PLATFORM}/api/runs/${runId}/events`)
  if (!res.ok || !res.body) throw new Error('无法订阅执行事件流')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  while (!finished) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      let event
      try { event = JSON.parse(line.slice(6)) } catch { continue }
      switch (event.type) {
        case 'run:start':
          console.log(`\n[demo] 开始执行：${event.run.name}（共 ${event.run.total} 个用例）`)
          break
        case 'case:start':
          process.stdout.write(`[demo] (${event.index}/${event.total}) ${event.name} … `)
          break
        case 'case:end':
          console.log(`${STATUS_ICON[event.status] ?? ''} ${event.status}（${event.durationMs} ms）`)
          break
        case 'run:log':
          console.log(`[demo] ${event.message}`)
          break
        case 'assertion':
          if (!event.result.ok) console.log(`        ↳ 断言失败：${event.result.label} — ${event.result.message}`)
          break
        case 'run:end':
          finished = true
          break
        default:
          break
      }
    }
  }
  try { await reader.cancel() } catch { /* ignore */ }
  return runId
}

async function main() {
  console.log('=== 测试平台一键演示 ===')
  if (!existsSync(join(CODE_ROOT, 'web', 'dist', 'index.html'))) {
    console.log('[demo] 提示：前端尚未构建（web/dist 不存在），界面将不可用；先执行 `npm run build`。')
  }

  console.log(`[demo] 启动示例被测软件（端口 ${DEMO_PORT}）…`)
  startServer('demo-app', join(CODE_ROOT, 'examples', 'demo-app', 'server.mjs'), { PORT: String(DEMO_PORT) })
  await waitFor(`http://127.0.0.1:${DEMO_PORT}/api/health`, { label: '示例被测软件' })
  console.log('[demo] 示例被测软件已就绪：http://127.0.0.1:' + DEMO_PORT)

  console.log(`[demo] 启动测试平台（端口 ${PLATFORM_PORT}）…`)
  startServer('platform', join(CODE_ROOT, 'server', 'src', 'index.mjs'), { PORT: String(PLATFORM_PORT) })
  await waitFor(`${PLATFORM}/api/health`, { label: '测试平台' })
  console.log(`[demo] 测试平台已就绪：${PLATFORM}`)

  if (SERVE) {
    console.log('[demo] 演示环境已就绪（未自动执行用例）：')
    console.log(`[demo]   测试平台界面：${PLATFORM}/`)
    console.log(`[demo]   示例被测软件：http://127.0.0.1:${DEMO_PORT}/`)
    console.log('[demo]   建议演示顺序：导入示例 → 全部运行 → 看实时日志与断言 → 打开 HTML 报告 → 查看失败截图')
    openBrowser(`${PLATFORM}/`)
    console.log('[demo] 按 Ctrl+C 结束。')
    return
  }

  console.log('[demo] 导入示例用例…')
  const imported = await (await fetch(`${PLATFORM}/api/examples/demo-app/import`, { method: 'POST' })).json()
  if (imported.error) throw new Error(imported.error)
  console.log(`[demo] 已导入项目「${imported.project.name}」，用例 ${imported.caseCount} 个`)

  const runRes = await (await fetch(`${PLATFORM}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: imported.project.id, name: '一键演示 · 全量用例' }),
  })).json()
  if (runRes.error) throw new Error(runRes.error)

  await streamRun(runRes.runId)

  const run = await (await fetch(`${PLATFORM}/api/runs/${runRes.runId}`)).json()
  const s = run.summary
  console.log('\n=== 执行结果 ===')
  console.log(`用例：${s.total} 个 · 通过 ${s.passed} · 失败 ${s.failed} · 异常 ${s.error} · 耗时 ${run.durationMs} ms`)
  for (const item of run.results) {
    const failed = (item.steps ?? []).flatMap((st) => st.assertions ?? []).filter((a) => !a.ok)
    console.log(`  ${STATUS_ICON[item.status] ?? ''} ${item.name}${failed.length ? ` —— 失败断言 ${failed.length} 条` : ''}`)
    for (const a of failed.slice(0, 3)) console.log(`      · ${a.label}：${a.message}`)
  }
  console.log(`\n报告：${PLATFORM}/api/runs/${runRes.runId}/report`)
  console.log(`界面：${PLATFORM}/`)

  if (OPEN) {
    openBrowser(`${PLATFORM}/api/runs/${runRes.runId}/report`)
  }

  if (ONCE) {
    shutdown(0)
    return
  }
  console.log('\n[demo] 演示环境保持运行中，按 Ctrl+C 结束（可用 --once 跑完即退出）。')
}

main().catch((error) => {
  console.error(`[demo] 失败：${error.message}`)
  shutdown(1)
})
