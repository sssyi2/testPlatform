#!/usr/bin/env node
/**
 * 一键完整验收：在同一个进程里拉起「示例被测软件 + 测试平台」，然后
 *   1) 跑 API 层自测（导入示例 → 执行全部用例 → 校验断言/截图/报告）
 *   2) 跑界面自测（真的用浏览器点界面走一遍全流程，并逐步截图）
 * 最后给出统一结论。
 *
 * 用法：
 *   node tools/verify-all.mjs                 # 无头
 *   node tools/verify-all.mjs --headed        # 显示浏览器窗口（录屏素材）
 *   node tools/verify-all.mjs --skip-ui       # 只跑 API 层自测
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 *
 * 需要前端已构建（npm run build）。若未构建，界面自测会失败并提示。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { runSelfTest } from './selftest.mjs'
import { runUiSmoke } from './ui-smoke.mjs'

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM_PORT = Number(process.env.PLATFORM_PORT ?? 4619)
// 示例用例里写的是 4517（被测软件的默认端口），这里默认也用 4517，
// 这样界面里点「运行全部」时项目 baseUrl 才是通的。
const DEMO_PORT = Number(process.env.DEMO_PORT ?? 4517)
const HEADED = process.argv.includes('--headed')
const SKIP_UI = process.argv.includes('--skip-ui')
const UI_ONLY = process.argv.includes('--ui-only')

function banner(text) {
  console.log(`\n${'='.repeat(8)} ${text} ${'='.repeat(8)}`)
}

async function main() {
  console.log('测试平台 · 一键完整验收')
  console.log(`平台端口：${PLATFORM_PORT}　示例被测软件端口：${DEMO_PORT}`)

  banner('第一步：API 层自测')
  const selfTest = await runSelfTest({
    platformPort: PLATFORM_PORT,
    demoPort: DEMO_PORT,
    startServers: true,
    keepServers: true,
    startOnly: UI_ONLY,   // --ui-only 时只把服务拉起来，不跑 API 层用例
  })

  let ui = null
  if (SKIP_UI) {
    console.log('\n（--skip-ui：跳过界面自测）')
  } else if (!existsSync(join(CODE_ROOT, 'web', 'dist', 'index.html'))) {
    console.log('\n⚠️ 前端未构建，跳过界面自测。请先执行：npm run build')
  } else {
    banner('第二步：界面自测（真实浏览器操作 + 截图）')
    ui = await runUiSmoke({
      platform: selfTest.platform,
      outDir: join(CODE_ROOT, 'data', 'ui-shots'),
      headed: HEADED,
    })
  }

  banner('验收结论')
  console.log(`API 层自测：${selfTest.ok ? '✅ 通过' : '❌ 失败'}`)
  for (const item of selfTest.results) console.log(`   ${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
  if (ui) {
    console.log(`界面自测　：${ui.ok ? '✅ 通过' : '❌ 失败'}`)
    for (const item of ui.steps) console.log(`   ${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
    console.log(`界面截图　：${join(CODE_ROOT, 'data', 'ui-shots')}`)
  }
  if (selfTest.run) {
    const s = selfTest.run.summary
    console.log(`\n本次执行：${s.total} 个用例 · 通过 ${s.passed} · 失败 ${s.failed} · 异常 ${s.error} · 耗时 ${selfTest.run.durationMs} ms`)
    console.log(`报告地址：${selfTest.platform}/api/runs/${selfTest.runId}/report`)
  }

  const ok = selfTest.ok && (ui === null || ui.ok)
  console.log(`\n总体：${ok ? '✅ 全部通过' : '❌ 存在失败项'}`)
  return ok
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error(`\n❌ 验收异常：${error.stack ?? error.message}`)
    process.exit(1)
  })
