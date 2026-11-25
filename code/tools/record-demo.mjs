#!/usr/bin/env node
/**
 * 自动录屏：用 Playwright 真的去操作平台界面，同时把画面录下来，转成 mp4。
 *
 * 为什么要脚本录：
 *  - 可复现：任何人执行同一条命令都能得到同样的演示；
 *  - 不污染数据：默认用独立数据目录（code/.recording-data）和独立端口（4521）；
 *  - 有讲解：画面底部有步骤字幕，点击前会高亮目标元素。
 *
 * 用法（工作目录 code/）：
 *   node tools/record-demo.mjs
 *   node tools/record-demo.mjs --name 20261125-小商城示例-全流程测试 --platform-port 4521 --headed
 *
 * 产物：
 *   video/<name>.mp4              录屏
 *   video/<name>.md               录像说明（被测对象、结果、缺陷、执行 ID）
 *   video/<name>-报告.html        本次执行的自包含报告（可直接打开）
 *   video/<name>-封面.jpg         封面帧
 *
 * 前置：示例被测软件需可访问（默认 http://127.0.0.1:4517，脚本会尝试自动拉起）；
 *       需要 Chromium（code/.playwright-browsers）与带 x264 的 ffmpeg（见下）。
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { runSelfTest } from './selftest.mjs'

const CODE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(CODE_ROOT, '..')

const argValue = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const today = new Date()
  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
const NAME = argValue('--name', `${stamp}-小商城示例-全流程测试`)
const PLATFORM_PORT = Number(argValue('--platform-port', '4521'))
const DEMO_PORT = Number(argValue('--demo-port', '4517'))
const HEADED = process.argv.includes('--headed')
const WIDTH = 1440
const HEIGHT = 900

const VIDEO_DIR = join(REPO_ROOT, 'video')
const RECORDING_DATA = join(CODE_ROOT, '.recording-data')
const RAW_VIDEO_DIR = join(CODE_ROOT, '.recording-video')
const FFMPEG = join(CODE_ROOT, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')

const PLATFORM = `http://127.0.0.1:${PLATFORM_PORT}`
const DEMO = `http://127.0.0.1:${DEMO_PORT}`

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(CODE_ROOT, '.playwright-browsers')

const log = (...args) => console.log('[record]', ...args)

// ----------------------------------------------------------------- 画面辅助

/** 底部字幕条（固定在视口底部，不挡主要操作区）。 */
async function caption(page, text, sub = '') {
  await page.evaluate(
    ({ text, sub }) => {
      // 记进 sessionStorage：同源页面导航/表单 POST 跳转后由 initScript 自动恢复
      try {
        sessionStorage.setItem('__rec_cap_text', text)
        sessionStorage.setItem('__rec_cap_sub', sub)
      } catch { /* 某些页面禁用 storage 时忽略 */ }
      let bar = document.getElementById('__rec_caption')
      if (!bar) {
        bar = document.createElement('div')
        bar.id = '__rec_caption'
        bar.style.cssText = [
          'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
          'background:rgba(15,23,42,.92)', 'color:#fff', 'padding:10px 18px',
          'font:600 16px/1.45 "Microsoft YaHei","PingFang SC",system-ui,sans-serif',
          'display:flex', 'align-items:center', 'gap:12px',
          'box-shadow:0 -2px 12px rgba(0,0,0,.25)', 'pointer-events:none',
        ].join(';')
        document.documentElement.appendChild(bar)
      }
      bar.innerHTML = `<span style="display:inline-block;background:#ef4444;border-radius:4px;padding:1px 7px;font-size:12px">演示</span><span>${text}</span>${sub ? `<span style="opacity:.7;font-weight:400;font-size:13px;margin-left:auto">${sub}</span>` : ''}`
    },
    { text: String(text), sub: String(sub) },
  )
}

/** 让字幕在同源导航（含表单 POST 302 跳转）后自动恢复。 */
async function installCaptionRestore(page) {
  await page.addInitScript(() => {
    const paint = () => {
      let text = ''
      let sub = ''
      try {
        text = sessionStorage.getItem('__rec_cap_text') || ''
        sub = sessionStorage.getItem('__rec_cap_sub') || ''
      } catch { /* ignore */ }
      if (!text) return
      let bar = document.getElementById('__rec_caption')
      if (!bar) {
        bar = document.createElement('div')
        bar.id = '__rec_caption'
        bar.style.cssText = [
          'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:2147483647',
          'background:rgba(15,23,42,.92)', 'color:#fff', 'padding:10px 18px',
          'font:600 16px/1.45 "Microsoft YaHei","PingFang SC",system-ui,sans-serif',
          'display:flex', 'align-items:center', 'gap:12px',
          'box-shadow:0 -2px 12px rgba(0,0,0,.25)', 'pointer-events:none',
        ].join(';')
        document.documentElement.appendChild(bar)
      }
      bar.innerHTML = `<span style="display:inline-block;background:#ef4444;border-radius:4px;padding:1px 7px;font-size:12px">演示</span><span>${text}</span>${sub ? `<span style="opacity:.7;font-weight:400;font-size:13px;margin-left:auto">${sub}</span>` : ''}`
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint)
    else paint()
  })
}

/** 点击前高亮元素，让录像里看得清点了哪里。 */
async function highlight(locator, ms = 900) {
  try {
    await locator.evaluate((el, ms) => {
      const prev = el.style.outline
      el.style.outline = '3px solid #ef4444'
      el.style.outlineOffset = '2px'
      el.style.boxShadow = '0 0 0 6px rgba(239,68,68,.25)'
      setTimeout(() => { el.style.outline = prev; el.style.boxShadow = '' }, ms)
    }, ms)
  } catch { /* 元素已消失就忽略 */ }
}

/** 平滑滚动（递归滚几屏）。 */
async function smoothScroll(page, totalPx, steps = 8, stepMs = 220) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: 'smooth' }), Math.round(totalPx / steps))
    await delay(stepMs)
  }
}

async function firstVisible(page, selectors, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = page.locator(selector).first()
      try {
        if (await loc.isVisible({ timeout: 250 })) return loc
      } catch { /* 换下一个 */ }
    }
    await delay(120)
  }
  return null
}

/** 出问题时把界面现状打出来，避免"找不到元素"这种无信息报错。 */
async function dumpUi(page, label) {
  const info = await page
    .evaluate(() => ({
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      buttons: [...document.querySelectorAll('button')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => (b.innerText || '').trim())
        .filter(Boolean)
        .slice(0, 40),
      text: (document.body.innerText || '').replace(/\n+/g, ' | ').slice(0, 600),
    }))
    .catch(() => null)
  log(`[UI@${label}]`, JSON.stringify(info))
}

// ----------------------------------------------------------------- 主流程

async function main() {
  if (!existsSync(FFMPEG)) {
    throw new Error(`找不到带 x264 的 ffmpeg：${FFMPEG}\n请先执行：node "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" install --no-save --ignore-scripts @ffmpeg-installer/win32-x64`)
  }
  if (!existsSync(VIDEO_DIR)) mkdirSync(VIDEO_DIR, { recursive: true })
  for (const dir of [RECORDING_DATA, RAW_VIDEO_DIR]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
  }

  // 1) 拉起「示例被测软件 + 独立数据目录的平台实例」
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(CODE_ROOT, '.playwright-browsers')
  process.env.TESTPLATFORM_DATA_DIR = RECORDING_DATA
  log(`启动服务：平台 ${PLATFORM}（数据目录 ${RECORDING_DATA}），被测软件 ${DEMO}`)
  const started = await runSelfTest({
    platformPort: PLATFORM_PORT,
    demoPort: DEMO_PORT,
    startServers: true,
    keepServers: true,
    startOnly: true,
    quiet: true,
  })
  log('服务就绪')

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: !HEADED })
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    recordVideo: { dir: RAW_VIDEO_DIR, size: { width: WIDTH, height: HEIGHT } },
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  await installCaptionRestore(page)
  const video = page.video()

  let runId = null
  try {
    // 场景 1：首页
    await page.goto(PLATFORM, { waitUntil: 'networkidle' })
    await caption(page, '通用软件测试平台：声明式用例 + 一键执行 + 实时日志 + 带证据的报告', '01 首页')
    await delay(2600)

    // 场景 2：导入示例
    const importBtn = await firstVisible(page, ['button:has-text("导入示例")', 'text=导入示例'])
    if (!importBtn) throw new Error('找不到「导入示例」按钮')
    await highlight(importBtn)
    await caption(page, '一键导入内置示例项目（11 个用例：8 个 API + 3 个 Web）', '02 导入示例')
    await importBtn.click()
    await delay(900)
    const importRow = await firstVisible(page, ['.example-item button', '.example-list button'])
    if (!importRow) {
      await dumpUi(page, '导入弹窗里没有导入按钮')
      throw new Error('找不到示例条目的「导入」按钮')
    }
    await highlight(importRow)
    await importRow.click()
    await delay(1200)
    await dumpUi(page, '导入后')
    await page.waitForSelector('.case-table, table, h2:has-text("用例列表"), button:has-text("运行全部")', { timeout: 15000 }).catch(() => {})
    await delay(1600)

    // 场景 3：用例列表
    await caption(page, '用例是声明式的：请求 / 页面动作 + 断言 + 变量抽取，不需要写代码', '03 用例列表')
    await smoothScroll(page, 520, 6, 200)
    await delay(700)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
    await delay(600)

    // 场景 4：打开用例编辑器（整页视图，用「返回列表」退出）
    const editBtn = await firstVisible(page, ['button:text-is("编辑")', 'tbody button:has-text("编辑")'])
    if (editBtn) {
      await highlight(editBtn)
      await caption(page, '打开用例看配置：多步骤串联 + 变量抽取（token）+ 逐条断言', '04 用例配置')
      await editBtn.click()
      await page.waitForSelector('button:has-text("返回列表")', { timeout: 10000 }).catch(() => {})
      await delay(1400)
      await smoothScroll(page, 760, 7, 230)
      await delay(900)
      const backBtn = await firstVisible(page, ['button:has-text("返回列表")'], 4000)
      if (backBtn) {
        await highlight(backBtn, 500)
        await backBtn.click()
        await delay(1400)
      }
    } else {
      log('跳过编辑器场景：找不到「编辑」按钮')
    }

    // 保险：确保已经回到用例列表
    const strayBack = await firstVisible(page, ['button:has-text("返回列表")'], 1200)
    if (strayBack) {
      await strayBack.click()
      await delay(1200)
    }

    // 场景 5：全部运行
    const runBtn = await firstVisible(page, [
      'button:has-text("运行全部启用")',
      'button:has-text("运行全部")',
      'button:has-text("全部运行")',
      'button:has-text("运行选中")',
      'button:has-text("运行")',
    ], 12000)
    if (!runBtn) {
      await dumpUi(page, '找不到运行按钮')
      throw new Error('找不到运行按钮')
    }
    const runLabel = (await runBtn.innerText()).trim()
    await highlight(runBtn)
    await caption(page, `点击「${runLabel}」，实时看每个用例、每个步骤的执行情况`, '05 执行')
    await runBtn.click()

    // 等执行结束（顺便展示实时日志滚动）
    const runs = await (await fetch(`${PLATFORM}/api/runs?limit=1`)).json()
    runId = runs?.[0]?.id
    if (!runId) throw new Error('未能获取执行记录')
    let run = runs[0]
    const deadline = Date.now() + 180000
    await caption(page, '执行中：进度、用例状态灯、实时日志、断言结果同步刷新', '06 实时日志')
    while (Date.now() < deadline && run.status === 'running') {
      await delay(800)
      run = await (await fetch(`${PLATFORM}/api/runs/${runId}`)).json()
    }
    const s = run.summary
    log(`执行结束：${run.status} 通过 ${s.passed} 失败 ${s.failed} 异常 ${s.error}`)
    await delay(1200)

    // 场景 6：结果与断言明细
    await caption(page, `执行结束：${s.total} 个用例 · 通过 ${s.passed} · 失败 ${s.failed}（失败正是被测软件的真实缺陷）`, '07 结果')
    await smoothScroll(page, 620, 6, 220)
    await delay(900)

    // 场景 7：HTML 报告（同一页导航，保证一段连续录像）
    await page.goto(`${PLATFORM}/api/runs/${runId}/report`, { waitUntil: 'domcontentloaded' })
    await caption(page, '自动生成自包含 HTML 报告：断言「期望 vs 实际」+ 失败截图，单文件即可归档', '08 HTML 报告')
    await delay(1500)
    await smoothScroll(page, 900, 8, 240)
    await delay(900)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
    await delay(700)

    // 场景 8：被测软件本身
    await page.goto(`${DEMO}/`, { waitUntil: 'domcontentloaded' })
    await caption(page, '这就是被测软件：示例「小商城」（故意植入 4 个缺陷，用来验证平台能测出问题）', '09 被测软件')
    await delay(1800)
    await page.fill('[data-testid="username"]', 'admin').catch(() => {})
    await page.fill('[data-testid="password"]', '123456').catch(() => {})
    await delay(700)
    await page.click('[data-testid="login-btn"]').catch(() => {})
    await page.waitForSelector('[data-testid="product-list"]', { timeout: 10000 }).catch(() => {})
    await delay(1400)
    await page.click('[data-testid="add-to-cart"]').catch(() => {})
    await delay(900)
    await page.fill('[data-testid="coupon-input"]', 'SAVE10').catch(() => {})
    await delay(700)
    await page.click('[data-testid="checkout-btn"]').catch(() => {})
    await delay(1800)
    await caption(page, '前端缺陷：合计金额被截断成整数（「52 元」而不是 52.91），Web 用例因此失败并自动截图', '10 缺陷现场')
    await delay(2200)

    // 场景 9：回到执行记录
    await page.goto(`${PLATFORM}/`, { waitUntil: 'networkidle' })
    await caption(page, '执行记录可追溯：随时回看每次执行的明细与报告', '11 执行记录')
    await delay(800)
    const historyTab = await firstVisible(page, ['button:has-text("执行记录")', 'text=执行记录'], 4000)
    if (historyTab) {
      await highlight(historyTab)
      await historyTab.click()
      await delay(1800)
      await smoothScroll(page, 400, 4, 220)
    }
    await caption(page, '测试平台 · 演示结束', '')
    await delay(2000)
  } finally {
    // 收尾：关掉页面以落盘视频
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }

  // ----------------------------------------------------------------- 转 mp4
  const webm = video ? await video.path().catch(() => null) : null
  if (!webm || !existsSync(webm)) throw new Error('没有生成视频文件（recordVideo 未产出）')
  log(`原始录像：${webm}（${(statSync(webm).size / 1024 / 1024).toFixed(1)} MB）`)

  const mp4 = join(VIDEO_DIR, `${NAME}.mp4`)
  const ff = spawnSync(FFMPEG, [
    '-y', '-i', webm,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    mp4,
  ], { encoding: 'utf8' })
  if (ff.status !== 0) throw new Error(`ffmpeg 转码失败：${(ff.stderr || '').slice(-800)}`)
  log(`已转码：${mp4}`)

  // 封面帧（取第 6 秒）
  const poster = join(VIDEO_DIR, `${NAME}-封面.jpg`)
  spawnSync(FFMPEG, ['-y', '-ss', '6', '-i', mp4, '-frames:v', '1', '-q:v', '3', poster])

  // 报告附件
  if (runId) {
    const html = await (await fetch(`${PLATFORM}/api/runs/${runId}/report`)).text()
    writeFileSync(join(VIDEO_DIR, `${NAME}-报告.html`), html, 'utf8')
  }

  // 录像说明
  const detail = runId ? await (await fetch(`${PLATFORM}/api/runs/${runId}`)).json() : null
  const summary = detail?.summary ?? {}
  const failedCases = (detail?.results ?? []).filter((r) => r.status !== 'passed')
  const lines = [
    `# 录像说明：${NAME}`,
    '',
    `- **录像文件**：\`video/${NAME}.mp4\``,
    `- **录制方式**：Playwright 自动操作平台界面并录制浏览器画面（\`code/tools/record-demo.mjs\`），非人工剪辑`,
    `- **录制时间**：${new Date().toLocaleString('zh-CN')}`,
    `- **被测软件**：示例「小商城」${DEMO}（零依赖 Node 服务，故意植入 4 个缺陷，见 \`code/examples/demo-app/BUGS.md\`）`,
    `- **测试范围**：11 个用例（8 API + 3 Web），含冒烟、负向、边界、链路（登录→下单）与 UI 断言`,
    `- **平台执行 ID**：\`${runId ?? '（未获取）'}\``,
    `- **结果**：共 ${summary.total ?? '?'} 个 · 通过 ${summary.passed ?? '?'} · 失败 ${summary.failed ?? '?'} · 异常 ${summary.error ?? '?'}`,
    '',
    '## 录到的失败用例（= 被测软件的真实缺陷）',
    '',
    ...(failedCases.length
      ? failedCases.map((r) => {
        const bad = (r.steps ?? []).flatMap((st) => st.assertions ?? []).filter((a) => !a.ok)
        return `- **${r.name}**（${r.type}）：` + (bad.map((a) => a.message).join('；') || r.status)
      })
      : ['（本次没有失败用例）']),
    '',
    '## 附件',
    '',
    `- 本次执行的自包含报告：\`video/${NAME}-报告.html\`（内联截图，双击即可看）`,
    `- 封面帧：\`video/${NAME}-封面.jpg\``,
    '',
    '## 复现方式',
    '',
    '```powershell',
    'cd E:\\testPlatform\\code',
    'node tools/record-demo.mjs            # 同样的操作、同样的步骤字幕，重新录一次',
    '```',
  ]
  writeFileSync(join(VIDEO_DIR, `${NAME}.md`), lines.join('\n'), 'utf8')

  log(`录像说明：video/${NAME}.md`)
  log('完成')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[record] 失败：', error?.stack ?? error)
    process.exit(1)
  })
