#!/usr/bin/env node
/**
 * 自测（API 层，无需浏览器）：在一个进程里同时拉起「示例被测软件」和「测试平台」，
 * 走完整流程（导入示例 → 执行全部用例 → 校验断言/报告），最后打印结论。
 *
 * 用法：node tools/selftest.mjs [--keep]
 * 退出码：0 = 自测通过；1 = 自测失败。
 *
 * 也可以作为模块使用（供 tools/verify-all.mjs 组合）：
 *   import { runSelfTest } from './selftest.mjs'
 *   const result = await runSelfTest({ startServers: true, keepServers: true, quiet: true })
 *
 * 说明：整个过程不派生任何子进程，因此在受限环境里也能跑（Web 用例除外，那需要浏览器）。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch { /* 还没起来，继续等 */ }
    await delay(200)
  }
  throw new Error(`等待 ${url} 超时（${timeoutMs}ms）`)
}

/**
 * 跑一次完整自测。
 * @param {object} options
 *   platformPort 平台端口（默认 4599）
 *   demoPort     示例被测软件端口（默认 4598）
 *   startServers 是否在本进程内启动两个服务（默认 true）
 *   keepServers  结束后是否保留服务（默认 false，配合 startServers 使用）
 *   quiet        是否少打印
 * @returns {{ ok: boolean, results: Array, runId?: string, platform: string, demoUrl: string, run?: object }}
 */
export async function runSelfTest(options = {}) {
  const platformPort = Number(options.platformPort ?? 4599)
  const demoPort = Number(options.demoPort ?? 4598)
  const startServers = options.startServers !== false
  const keepServers = Boolean(options.keepServers)
  const quiet = Boolean(options.quiet)
  const platform = `http://127.0.0.1:${platformPort}`
  const demoUrl = `http://127.0.0.1:${demoPort}`

  const results = []
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail })
    if (!quiet) console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  if (!quiet) console.log('=== 测试平台自测 ===')

  // 1) 示例被测软件
  if (startServers) {
    process.env.PORT = String(demoPort)
    const demoPath = join(CODE_ROOT, 'examples', 'demo-app', 'server.mjs')
    if (!existsSync(demoPath)) throw new Error(`找不到示例被测软件：${demoPath}`)
    const demoModule = await import(`file://${demoPath.replace(/\\/g, '/')}`)
    // 示例软件只在「直接运行」时自动监听；被 import 时由调用方决定端口。
    if (demoModule?.server && !demoModule.server.listening) {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
          // 端口已被占用：假定已有实例在跑（例如用户自己开的演示环境），继续走健康检查
          if (error?.code === 'EADDRINUSE') {
            if (!quiet) console.log(`   [selftest] 端口 ${demoPort} 已被占用，复用已有实例`)
            resolveListen()
            return
          }
          rejectListen(error)
        }
        demoModule.server.once('error', onError)
        demoModule.server.listen(demoPort, '127.0.0.1', () => {
          demoModule.server.off('error', onError)
          if (!quiet) console.log(`   [selftest] 示例被测软件监听于 http://127.0.0.1:${demoPort}`)
          resolveListen()
        })
      })
    }
  }
  const demoHealth = await waitFor(`${demoUrl}/api/health`)
  check('示例被测软件启动', Boolean(demoHealth?.status), JSON.stringify(demoHealth).slice(0, 120))

  // 2) 平台服务
  if (startServers) {
    process.env.PORT = String(platformPort)
    await import(`file://${join(CODE_ROOT, 'server', 'src', 'index.mjs').replace(/\\/g, '/')}`)
  }
  const health = await waitFor(`${platform}/api/health`)
  check('平台服务启动', health?.ok === true, `browsersReady=${health?.browsersReady}`)

  // 只要求把服务拉起来（供 verify-all --ui-only 之类的组合使用）
  if (options.startOnly) {
    return { ok: true, results, platform, demoUrl, health }
  }

  // 3) 导入示例项目
  const imported = await (await fetch(`${platform}/api/examples/demo-app/import`, { method: 'POST' })).json()
  if (imported.error) throw new Error(`导入示例失败：${imported.error}`)
  check('导入示例项目与用例', imported.caseCount >= 5, `${imported.caseCount} 个用例`)

  // 4) 执行全部用例（把 baseUrl 覆盖成本次实际端口，示例用例默认写的是 4517）
  const startRes = await (await fetch(`${platform}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: imported.project.id,
      name: '自测 · 全量用例',
      variables: { baseUrl: demoUrl },
    }),
  })).json()
  if (startRes.error) throw new Error(`启动执行失败：${startRes.error}`)
  if (!quiet) console.log(`   执行 ID：${startRes.runId}`)

  let run = null
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    run = await (await fetch(`${platform}/api/runs/${startRes.runId}`)).json()
    if (run.status !== 'running') break
    await delay(500)
  }
  if (!run || run.status === 'running') throw new Error('执行超时（>180s）')

  const summary = run.summary
  check('执行流程跑通', ['passed', 'failed'].includes(run.status), `状态=${run.status}，用例=${summary.total}`)
  check('存在通过的用例', summary.passed > 0, `通过 ${summary.passed}`)
  check('能测出被测软件缺陷（存在失败用例）', summary.failed + summary.error > 0,
    `失败 ${summary.failed} · 异常 ${summary.error}`)

  const apiResults = run.results.filter((r) => r.type === 'api')
  const webResults = run.results.filter((r) => r.type === 'web')
  check('API 用例已执行', apiResults.length > 0, `${apiResults.length} 个`)

  const healthCase = run.results.find((r) => r.name.includes('健康'))
  if (healthCase) {
    const assertion = (healthCase.steps?.[0]?.assertions ?? [])[0]
    check('健康检查用例断言通过', healthCase.status === 'passed', assertion ? assertion.message : '无用例')
  } else {
    check('健康检查用例存在', false, '未找到名称含「健康」的用例')
  }

  // 5) Web 用例（Chromium 未安装时跳过，不算失败）
  if (health?.browsersReady) {
    check('Web 用例已执行', webResults.length > 0, `${webResults.length} 个`)
    const shots = run.results.flatMap((r) => r.screenshots ?? [])
    check('Web 用例产生截图证据', shots.length > 0 || webResults.every((r) => r.status === 'passed'), `${shots.length} 张截图`)
  } else if (!quiet) {
    console.log('⏭️ 跳过 Web 用例检查：Chromium 未安装（执行 node tools/install-browsers.mjs）')
  }

  // 6) 报告导出
  const reportRes = await fetch(`${platform}/api/runs/${startRes.runId}/report`)
  const html = await reportRes.text()
  const reportFile = join(CODE_ROOT, 'data', `selftest-report-${startRes.runId}.html`)
  mkdirSync(dirname(reportFile), { recursive: true })
  writeFileSync(reportFile, html, 'utf8')
  check('HTML 报告可导出', html.includes('测试报告') && html.length > 2000, `${html.length} 字节 → ${reportFile}`)

  // 7) 「预期失败（xfail）」语义：已知缺陷用例失败时不应判定整次执行为失败
  const xfailCase = await (await fetch(`${platform}/api/projects/${imported.project.id}/cases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '预期失败语义验证（已知缺陷）',
      type: 'api',
      tags: ['selftest'],
      expectedFailure: true,
      steps: [{
        name: '故意断言一个不成立的状态码',
        request: { method: 'GET', url: '{{baseUrl}}/api/health' },
        assertions: [{ type: 'status', op: 'equals', expected: '599' }],
      }],
    }),
  })).json()
  const xfailRunId = (await (await fetch(`${platform}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: imported.project.id, caseIds: [xfailCase.id], name: '自测 · 预期失败语义', variables: { baseUrl: demoUrl } }),
  })).json()).runId
  let xfailRun = null
  const xfailDeadline = Date.now() + 60000
  while (Date.now() < xfailDeadline) {
    xfailRun = await (await fetch(`${platform}/api/runs/${xfailRunId}`)).json()
    if (xfailRun.status !== 'running') break
    await delay(300)
  }
  const xfailResult = xfailRun?.results?.[0]
  check('预期失败用例记为 xfail 且不影响结论',
    xfailRun?.status === 'passed' && xfailRun?.summary?.xfail === 1 && xfailResult?.verdict === 'xfail',
    `状态=${xfailRun?.status}，xfail=${xfailRun?.summary?.xfail}，verdict=${xfailResult?.verdict}`)

  if (!quiet) {
    console.log('\n--- 用例结果 ---')
    for (const item of run.results) {
      const failed = (item.steps ?? []).flatMap((s) => s.assertions ?? []).filter((a) => !a.ok)
      const icon = item.status === 'passed' ? '✅' : item.status === 'failed' ? '❌' : '💥'
      console.log(`  ${icon} [${item.type}] ${item.name}（${item.durationMs} ms）`)
      for (const a of failed) console.log(`        ↳ ${a.label}：${a.message}`)
    }
    const failedChecks = results.filter((r) => !r.ok)
    console.log(`\n=== 自测结论：${failedChecks.length === 0 ? '通过' : `失败（${failedChecks.length} 项）`} ===`)
    for (const item of failedChecks) console.log(`  ❌ ${item.name} — ${item.detail}`)
  }

  if (!keepServers && startServers) {
    // 由调用方决定是否结束进程；这里仅返回结果
  }

  return { ok: results.every((r) => r.ok), results, runId: startRes.runId, platform, demoUrl, run, health }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  runSelfTest()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      console.error(`\n❌ 自测异常：${error.stack ?? error.message}`)
      process.exit(1)
    })
}
