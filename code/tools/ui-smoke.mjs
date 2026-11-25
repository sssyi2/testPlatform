#!/usr/bin/env node
/**
 * 界面自测：用 Playwright 真的去点平台的网页界面，走一遍
 * 「导入示例 → 全部运行 → 看实时日志 → 打开 HTML 报告」，并逐步截图。
 *
 * 前置：平台服务已启动且前端已构建（推荐 `node tools/demo.mjs --serve`，
 *       它会同时拉起示例被测软件与平台，并打开 http://127.0.0.1:4519/）。
 *
 * 用法：
 *   node tools/ui-smoke.mjs                 # 无头跑，截图存到 code/data/ui-shots/
 *   node tools/ui-smoke.mjs --headed        # 显示浏览器窗口（录屏/排障用）
 *   node tools/ui-smoke.mjs --platform http://127.0.0.1:4520 --out D:\shots
 *
 * 也可作为模块使用（供 tools/verify-all.mjs 组合）：
 *   import { runUiSmoke } from './ui-smoke.mjs'
 *   const result = await runUiSmoke({ platform: 'http://127.0.0.1:4599', quiet: true })
 *
 * 退出码：0 = 界面流程通过；1 = 有步骤失败（失败点会截图）。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(CODE_ROOT, '.playwright-browsers')

async function firstVisible(page, selectors, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first()
      try {
        if (await locator.isVisible({ timeout: 300 })) return locator
      } catch { /* 继续尝试下一个 */ }
    }
    await delay(200)
  }
  return null
}

/**
 * 跑一次界面自测。
 * @param {object} options { platform, outDir, headed, quiet }
 * @returns {{ ok: boolean, steps: Array, runId?: string, shots: string[] }}
 */
export async function runUiSmoke(options = {}) {
  const PLATFORM = options.platform ?? process.env.PLATFORM_URL ?? 'http://127.0.0.1:4519'
  const OUT_DIR = resolve(options.outDir ?? join(CODE_ROOT, 'data', 'ui-shots'))
  const HEADED = Boolean(options.headed)
  const quiet = Boolean(options.quiet)

  const steps = []
  const shots = []
  const record = (name, ok, detail = '') => {
    steps.push({ name, ok, detail })
    if (!quiet) console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  const { chromium } = await import('playwright')
  mkdirSync(OUT_DIR, { recursive: true })

  const health = await (await fetch(`${PLATFORM}/api/health`)).json()
  if (!health?.ok) throw new Error(`平台服务不可用：${PLATFORM}`)
  if (!health.webBuilt && !quiet) console.warn('⚠️ 后端报告前端未构建（webBuilt=false），界面可能只显示兜底页面')

  const browser = await chromium.launch({ headless: !HEADED })
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)

  let shotIndex = 0
  const shot = async (label) => {
    shotIndex++
    const file = join(OUT_DIR, `${String(shotIndex).padStart(2, '0')}-${label}.png`)
    await page.screenshot({ path: file }).catch(() => {})
    shots.push(file)
    return file
  }

  try {
    // 1. 打开界面
    await page.goto(PLATFORM, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    const title = await page.title()
    const bodyText = await page.locator('body').innerText().catch(() => '')
    record('界面可打开并渲染', bodyText.length > 20 && !bodyText.includes('前端尚未构建'), `标题=${title}，可见文本 ${bodyText.length} 字符`)
    record('页面没有明显错误文案', !/Uncaught|Cannot read propert|undefined is not/i.test(bodyText), '')
    await shot('home')

    // 2. 导入示例（如果已经有项目，则跳过导入）
    const importButton = await firstVisible(page, [
      'button:has-text("导入示例")', '[data-testid="import-example"]', 'text=导入示例',
    ], 5000)
    if (importButton) {
      await importButton.click()
      await delay(500)
      await shot('import-dialog')
      const confirm = await firstVisible(page, [
        '.example-item button',        // 示例清单一行的「导入」按钮（ProjectBar 的结构）
        '.example-list button',
        '[role="dialog"] button:has-text("导入")',
        'button:has-text("一键导入")',
        'button:has-text("导入")',
      ], 5000)
      if (confirm) {
        await confirm.click()
        record('点击导入示例', true, '')
      } else {
        const item = page.locator('text=demo-app').first()
        if (await item.count()) {
          await item.click().catch(() => {})
          const again = await firstVisible(page, ['button:has-text("导入")'], 3000)
          if (again) await again.click()
          record('点击导入示例', true, '通过示例条目触发')
        } else {
          record('点击导入示例', false, '没找到导入按钮/条目')
        }
      }
      await delay(1200)
    } else {
      record('找到「导入示例」入口', false, '界面上没找到（可能已有项目，继续后续步骤）')
    }
    await shot('cases')

    // 3. 用例列表应出现
    const caseRows = await page.locator('text=/健康检查|登录|订单|优惠券|库存|结算|搜索/').count()
    record('用例列表已渲染', caseRows > 0, `匹配到 ${caseRows} 处用例文本`)

    // 4. 全部运行
    const runAll = await firstVisible(page, [
      'button:has-text("运行全部")', 'button:has-text("全部运行")', 'button:has-text("运行选中")', 'button:has-text("运行")',
    ], 8000)
    if (!runAll) throw new Error('界面上找不到运行按钮')
    const runLabel = (await runAll.innerText().catch(() => '')).trim()
    await runAll.click()
    record('触发执行', true, `按钮文案：${runLabel}`)
    await delay(1500)
    await shot('running')

    // 5. 等执行结束（用 API 判定，界面负责展示）
    const runs = await (await fetch(`${PLATFORM}/api/runs?limit=1`)).json()
    const runId = runs?.[0]?.id
    if (!runId) throw new Error('没有查到执行记录')
    let run = runs[0]
    const deadline = Date.now() + 180000
    while (Date.now() < deadline && run.status === 'running') {
      await delay(1000)
      run = await (await fetch(`${PLATFORM}/api/runs/${runId}`)).json()
    }
    const summary = run.summary ?? {}
    record('执行已结束（界面流程闭环）', run.status !== 'running',
      `状态=${run.status}，共 ${summary.total}，通过 ${summary.passed}，失败 ${summary.failed}，异常 ${summary.error}`)

    // 界面触发的执行如果「全军覆没在异常」，通常是被测服务没在项目 baseUrl 上运行
    const allError = (summary.total ?? 0) > 0 && (summary.error ?? 0) === summary.total
    record('被执行的目标服务可达', !allError,
      allError
        ? `全部 ${summary.total} 个用例异常：请确认项目 baseUrl 指向的被测服务已启动（示例项目默认 http://127.0.0.1:4517）`
        : `通过 ${summary.passed}，失败 ${summary.failed}，异常 ${summary.error}`)
    await delay(1500)
    await shot('result')

    // 6. 失败断言在界面上可见（注意：列表接口只返回摘要，明细要取详情）
    const runDetail = await (await fetch(`${PLATFORM}/api/runs/${runId}`)).json()
    const pageText = await page.locator('body').innerText().catch(() => '')
    const failedAssertion = (runDetail.results ?? []).flatMap((r) => r.steps ?? []).flatMap((s) => s.assertions ?? []).find((a) => !a.ok)
    const showsFailure = failedAssertion ? (pageText.includes('失败') || pageText.includes('FAIL')) : true
    record('失败信息在界面可见', showsFailure,
      failedAssertion ? `${failedAssertion.label}：${failedAssertion.message}` : '本次没有失败断言')

    // 7. 打开 HTML 报告
    const reportPage = await context.newPage()
    await reportPage.goto(`${PLATFORM}/api/runs/${runId}/report`, { waitUntil: 'domcontentloaded' })
    const reportText = await reportPage.locator('body').innerText().catch(() => '')
    const reportShot = join(OUT_DIR, `${String(++shotIndex).padStart(2, '0')}-report.png`)
    await reportPage.screenshot({ path: reportShot, fullPage: true }).catch(() => {})
    shots.push(reportShot)
    record('HTML 报告可打开', reportText.includes('测试报告'), `${reportText.length} 字符`)
    await reportPage.close()

    // 8. 控制台错误检查
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await delay(1200)
    record('刷新后无未捕获异常', errors.length === 0, errors.slice(0, 3).join(' | '))
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }

  const failed = steps.filter((s) => !s.ok)
  if (!quiet) {
    console.log(`\n截图目录：${OUT_DIR}`)
    console.log(`=== 界面自测：${failed.length === 0 ? '通过' : `失败 ${failed.length} 项`} ===`)
    for (const item of failed) console.log(`  ❌ ${item.name} — ${item.detail}`)
  }
  return { ok: failed.length === 0, steps, runId: undefined, shots }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argValue = (name, fallback) => {
    const i = process.argv.indexOf(name)
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  runUiSmoke({
    platform: argValue('--platform', process.env.PLATFORM_URL ?? 'http://127.0.0.1:4519'),
    outDir: argValue('--out', join(CODE_ROOT, 'data', 'ui-shots')),
    headed: process.argv.includes('--headed'),
  })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      console.error(`\n❌ 界面自测异常：${error.stack ?? error.message}`)
      process.exit(1)
    })
}
