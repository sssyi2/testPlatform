/**
 * Web UI 用例执行器：用 Playwright 驱动 Chromium 完成页面操作并断言。
 *
 * 设计：
 * - 惰性加载 playwright：没装浏览器时给出可操作的中文提示，不影响 API 用例。
 * - 一次执行（run）复用一个浏览器实例，每个用例一个独立上下文（互不干扰）。
 * - 失败自动截图，作为回归证据写进 data/runs/<runId>/。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateAssertion } from '../assertions.mjs'
import { interpolate, interpolateDeep, builtinVars } from '../vars.mjs'
import { DATA_DIR } from '../store.mjs'

export const BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(DATA_DIR, '..', '.playwright-browsers')

let playwrightPromise = null

export async function loadPlaywright() {
  if (!playwrightPromise) {
    playwrightPromise = (async () => {
      try {
        process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_PATH
        const mod = await import('playwright')
        return mod
      } catch (error) {
        throw new Error(`无法加载 playwright（${error.message}）。请先执行：npm run install:browsers`)
      }
    })()
  }
  return playwrightPromise
}

export async function browsersReady() {
  try {
    await loadPlaywright()
  } catch {
    return false
  }
  return existsSync(BROWSERS_PATH) && (await import('node:fs')).readdirSync(BROWSERS_PATH).some((n) => n.startsWith('chromium'))
}

/** 启动一个浏览器实例（一次 run 用一次，用完 close）。 */
export async function launchBrowser({ headless = true } = {}) {
  const { chromium } = await loadPlaywright()
  try {
    return await chromium.launch({ headless, args: ['--disable-dev-shm-usage'] })
  } catch (error) {
    throw new Error(
      `Chromium 启动失败：${error.message}\n` +
      `如果是缺少浏览器，请执行：npm run install:browsers（安装到 ${BROWSERS_PATH}）`,
    )
  }
}

async function resolveElement(page, selector, timeoutMs) {
  if (!selector) return null
  const locator = page.locator(selector).first()
  const count = await page.locator(selector).count()
  const visible = count > 0 ? await locator.isVisible().catch(() => false) : false
  let text = ''
  try {
    text = count > 0 ? (await locator.innerText({ timeout: timeoutMs })).trim() : ''
  } catch {
    text = ''
  }
  return { count, visible, text }
}

/**
 * 执行一个 Web 用例。
 * @param {object} testCase 用例定义
 * @param {object} options { vars, baseUrl, emit, runId, artifactDir, browser }
 */
export async function runWebCase(testCase, options) {
  const { baseUrl, emit, browser, runId, artifactDir } = options
  const vars = { ...builtinVars(), ...(options.vars ?? {}) }
  const missing = new Set()
  const stepResults = []
  const screenshots = []
  const startedAt = Date.now()
  let status = 'passed'

  if (!browser) throw new Error('浏览器未启动（Web 用例需要 Chromium）')
  if (artifactDir && !existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true })

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const defaultTimeout = Number(testCase.timeoutMs ?? 15000)
  page.setDefaultTimeout(defaultTimeout)

  const saveShot = async (label) => {
    if (!artifactDir) return null
    const file = `${testCase.id}-${String(screenshots.length + 1).padStart(2, '0')}-${label}.png`.replace(/[^\w.-]/g, '_')
    const full = join(artifactDir, file)
    try {
      await page.screenshot({ path: full, fullPage: false })
      const url = `/api/artifacts/${runId}/${file}`
      screenshots.push(url)
      return url
    } catch {
      return null
    }
  }

  try {
    for (const [index, step] of (testCase.steps ?? []).entries()) {
      const stepStarted = Date.now()
      const logs = []
      const stepResult = {
        stepId: step.id ?? `step-${index + 1}`,
        name: step.name || `步骤 ${index + 1}`,
        status: 'passed',
        durationMs: 0,
        assertions: [],
        logs,
        screenshots: [],
      }
      emit?.({ type: 'step:start', caseId: testCase.id, stepId: stepResult.stepId, name: stepResult.name })

      const action = interpolateDeep(step.action ?? {}, vars, missing)
      const selector = action.selector ? interpolate(action.selector, vars, missing) : undefined
      const value = action.value !== undefined ? interpolate(String(action.value), vars, missing) : undefined
      const url = action.url ? interpolate(action.url, vars, missing) : undefined

      try {
        switch (action.type) {
          case 'goto': {
            const target = /^https?:\/\//i.test(url ?? '') ? url : `${(baseUrl ?? '').replace(/\/+$/, '')}${(url ?? '/').startsWith('/') ? '' : '/'}${url ?? '/'}`
            await page.goto(target, { waitUntil: 'domcontentloaded' })
            logs.push(`🌐 打开 ${target}`)
            break
          }
          case 'fill':
            await page.fill(selector, value ?? '')
            logs.push(`⌨️ 输入 ${selector} ← ${value ?? ''}`)
            break
          case 'click':
            await page.click(selector)
            logs.push(`🖱️ 点击 ${selector}`)
            break
          case 'select':
            await page.selectOption(selector, value ?? '')
            logs.push(`📋 选择 ${selector} = ${value ?? ''}`)
            break
          case 'press':
            await page.press(selector ?? 'body', value ?? 'Enter')
            logs.push(`⌨️ 按键 ${value ?? 'Enter'}`)
            break
          case 'hover':
            await page.hover(selector)
            logs.push(`🖱️ 悬停 ${selector}`)
            break
          case 'check':
            await page.check(selector)
            logs.push(`☑️ 勾选 ${selector}`)
            break
          case 'waitForSelector':
            await page.waitForSelector(selector, { timeout: Number(action.ms ?? defaultTimeout) })
            logs.push(`⏳ 等待元素 ${selector}`)
            break
          case 'waitForTimeout':
            await page.waitForTimeout(Number(action.ms ?? 500))
            logs.push(`⏳ 等待 ${action.ms ?? 500}ms`)
            break
          case 'screenshot':
            break
          default:
            throw new Error(`不支持的页面动作：${action.type}`)
        }
      } catch (error) {
        stepResult.status = 'error'
        stepResult.error = error.message
        logs.push(`❌ 操作失败：${error.message}`)
        const shot = await saveShot('error')
        if (shot) stepResult.screenshots.push(shot)
      }

      if (stepResult.status === 'passed') {
        for (const line of logs) emit?.({ type: 'step:log', caseId: testCase.id, stepId: stepResult.stepId, level: 'info', message: line })

        // 逐条断言解析目标元素：断言自带 selector 优先，缺省才回退到本步骤 action 的 selector。
        // （这样「点按钮 → 断言结果区域」这类常见写法才能正确工作。）
        const elementCache = new Map()
        const resolveCached = async (target) => {
          if (!target) return null
          if (!elementCache.has(target)) elementCache.set(target, await resolveElement(page, target, defaultTimeout))
          return elementCache.get(target)
        }

        const results = []
        for (const assertion of (step.assertions ?? []).filter(Boolean)) {
          const target = assertion.selector ?? selector
          const element = await resolveCached(target)
          results.push(evaluateAssertion(assertion, { url: page.url(), element }))
        }
        stepResult.assertions = results
        for (const r of results) emit?.({ type: 'assertion', caseId: testCase.id, stepId: stepResult.stepId, result: r })
        if (results.some((r) => !r.ok)) {
          stepResult.status = 'failed'
          for (const r of results.filter((x) => !x.ok)) logs.push(`❌ ${r.label}：${r.message}`)
        }
      }

      if (step.screenshot || stepResult.status !== 'passed') {
        const shot = await saveShot(stepResult.status === 'passed' ? 'step' : 'fail')
        if (shot) stepResult.screenshots.push(shot)
      }

      stepResult.durationMs = Date.now() - stepStarted
      stepResult.pageUrl = page.url()
      stepResults.push(stepResult)
      emit?.({ type: 'step:end', caseId: testCase.id, stepId: stepResult.stepId, status: stepResult.status, durationMs: stepResult.durationMs })

      if (stepResult.status !== 'passed') {
        status = stepResult.status
        if (!step.continueOnFail) break
      }
    }
  } catch (error) {
    status = 'error'
    const shot = await saveShot('case-error')
    return {
      caseId: testCase.id,
      name: testCase.name,
      type: testCase.type,
      tags: testCase.tags ?? [],
      status,
      durationMs: Date.now() - startedAt,
      startedAt,
      finishedAt: Date.now(),
      steps: stepResults,
      screenshots: shot ? [...screenshots] : [...screenshots],
      logs: [`❌ 用例执行异常：${error.message}`],
      error: error.message,
    }
  } finally {
    await context.close().catch(() => {})
  }

  if (missing.size) stepResults.push({
    stepId: 'vars',
    name: '变量检查',
    status: 'passed',
    durationMs: 0,
    assertions: [],
    logs: [`⚠️ 未定义变量：${[...missing].join(', ')}`],
    screenshots: [],
  })

  return {
    caseId: testCase.id,
    name: testCase.name,
    type: testCase.type,
    tags: testCase.tags ?? [],
    status,
    durationMs: Date.now() - startedAt,
    startedAt,
    finishedAt: Date.now(),
    steps: stepResults,
    screenshots,
    logs: [],
  }
}
