#!/usr/bin/env node
/**
 * 小商城（demo-app）自检脚本
 * ---------------------------------------------------------------------------
 * 先启动被测服务，再运行本脚本：
 *   node code/examples/demo-app/server.mjs                    # 终端 A
 *   node code/examples/demo-app/selfcheck.mjs                 # 终端 B：cases.json 契约 + API + HTML 选择器自检
 *   node code/examples/demo-app/selfcheck.mjs --cases-run     # 额外用平台执行器离线跑 cases.json 的 API 用例
 *   node code/examples/demo-app/selfcheck.mjs --web           # 额外用 Playwright 跑一遍浏览器流程
 *   node code/examples/demo-app/selfcheck.mjs --web --cases-run   # 全量
 *
 * 说明：本脚本断言的是「示例软件**按 BUGS.md 描述的缺陷行为**」，因此全部通过
 *       才代表被测对象符合预期；若某条「缺陷复现」检查失败，说明缺陷被修好了。
 *       前 3 段只用 Node 内置能力；--cases-run 需要平台代码；--web 需要 Playwright。
 *
 * 退出码：0 全部符合预期；1 有不符合预期的检查。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4517'
const WITH_WEB = process.argv.includes('--web')
const WITH_CASES_RUN = process.argv.includes('--cases-run')

let passed = 0
let failed = 0

function ok(name, detail = '') {
  passed++
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}

function bad(name, detail = '') {
  failed++
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
}

function check(name, condition, detail = '') {
  if (condition) ok(name, detail)
  else bad(name, detail)
}

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options)
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, headers: res.headers, text, json }
}

const jsonPost = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

async function apiChecks() {
  console.log('\n[2] REST API 自检')

  const health = await req('/api/health')
  check('健康检查返回 200 且 status=ok', health.status === 200 && health.json?.status === 'ok', `status=${health.status}`)

  const good = await req('/api/login', jsonPost({ username: 'admin', password: '123456' }))
  const token = good.json?.token
  check('正确账号登录返回 200 与 token', good.status === 200 && typeof token === 'string' && token.length > 0,
    `user=${JSON.stringify(good.json?.user)}`)
  check('登录响应只暴露 id/name/role', good.json?.user && Object.keys(good.json.user).join(',') === 'id,name,role')

  const alice = await req('/api/login', jsonPost({ username: 'alice', password: 'alice123' }))
  check('第二个账号 alice/alice123 也能登录', alice.status === 200 && !!alice.json?.token)

  const wrong = await req('/api/login', jsonPost({ username: 'admin', password: 'wrong' }))
  check('错误密码返回 401 与中文提示', wrong.status === 401 && wrong.json?.error === '用户名或密码错误', JSON.stringify(wrong.json))

  const all = await req('/api/products')
  check('商品列表至少 5 件', all.status === 200 && all.json?.items?.length >= 5 && all.json.total === all.json.items.length,
    `total=${all.json?.total}`)
  const earphone = await req('/api/products?keyword=' + encodeURIComponent('无线耳机'))
  check('按关键字过滤商品', earphone.status === 200 && earphone.json?.total === 1 && earphone.json.items[0].id === 'p1001',
    `total=${earphone.json?.total}`)
  const p1001 = await req('/api/products/p1001')
  check('商品详情返回价格 59.9 / 库存 10', p1001.status === 200 && p1001.json?.price === 59.9 && p1001.json?.stock === 10)
  const missing = await req('/api/products/not-exist-id')
  check('不存在的商品返回 404', missing.status === 404 && missing.json?.error === '商品不存在')

  const auth = { authorization: `Bearer ${token}` }

  const noToken = await req('/api/cart/checkout', jsonPost({ items: [{ productId: 'p1001', qty: 1 }] }))
  check('未登录下单返回 401', noToken.status === 401, JSON.stringify(noToken.json))
  const badToken = await req('/api/cart/checkout', jsonPost({ items: [{ productId: 'p1001', qty: 1 }] }, { authorization: 'Bearer not-a-real-token' }))
  check('无效 token 下单返回 401', badToken.status === 401)

  // ---- 缺陷 1：小额订单（59.9 元）应收取 10 元运费，实现里 shipping 恒为 0
  const order = await req('/api/cart/checkout', jsonPost({ items: [{ productId: 'p1001', qty: 1 }] }, auth))
  check('【缺陷 1 复现】小额订单运费应为 10，实际被写死为 0',
    order.status === 200 && order.json?.subtotal === 59.9 && order.json?.shipping === 0,
    `subtotal=${order.json?.subtotal} shipping=${order.json?.shipping}`)

  // ---- 缺陷 2：SAVE10 应按商品小计打 9 折（59.9 × 0.1 = 5.99），实现里多算了运费
  const coupon = await req('/api/cart/checkout', jsonPost({ items: [{ productId: 'p1001', qty: 1 }], couponCode: 'SAVE10' }, auth))
  check('【缺陷 2 复现】折扣应为 5.99（subtotal×0.1），实际按 (subtotal+运费)×0.1 算出 6.99',
    coupon.status === 200 && coupon.json?.discount === 6.99,
    `discount=${coupon.json?.discount} total=${coupon.json?.total}`)

  // ---- 缺陷 3：qty 超过库存应 400 { error: '库存不足' }，实现里跳过了库存校验
  const oversell = await req('/api/cart/checkout', jsonPost({ items: [{ productId: 'p1001', qty: 9999 }] }, auth))
  check('【缺陷 3 复现】库存只有 10 却允许下单 9999 件（应为 400 库存不足）',
    oversell.status === 200 && oversell.json?.orderId,
    `status=${oversell.status}`)

  const draft = await req('/api/orders/' + coupon.json.orderId, { headers: auth })
  check('订单详情可查询', draft.status === 200 && draft.json?.orderId === coupon.json.orderId)
  const orderList = await req('/api/orders', { headers: auth })
  check('订单列表返回本人订单', orderList.status === 200 && Array.isArray(orderList.json?.items) && orderList.json.items.length >= 3,
    `count=${orderList.json?.items?.length}`)
  const order404 = await req('/api/orders/not-exist-order', { headers: auth })
  check('不存在的订单返回 404', order404.status === 404)

  const echo = await req('/api/echo?status=500&body=boom')
  check('调试接口 /api/echo 返回指定状态与响应体', echo.status === 500 && echo.text === 'boom')
  const echoBad = await req('/api/echo?status=abc')
  check('非法 echo 状态码返回 400', echoBad.status === 400)

  const unknown = await req('/api/no-such-route')
  check('未知 API 返回 404 JSON', unknown.status === 404 && !!unknown.json?.error)

  return { token, user: good.json.user }
}

async function htmlChecks(token) {
  console.log('\n[3] HTML 页面与 data-testid 选择器自检')

  const login = await req('/')
  check('GET / 返回 200 HTML', login.status === 200 && login.headers.get('content-type')?.includes('text/html'))
  for (const id of ['username', 'password', 'login-btn', 'login-error']) {
    check(`登录页存在 [data-testid="${id}"]`, login.text.includes(`data-testid="${id}"`))
  }
  check('密码框是 type="password"', /data-testid="password"[^>]*type="password"|type="password"[^>]*data-testid="password"/.test(login.text))

  const shop = await req('/shop?token=' + encodeURIComponent(token))
  check('GET /shop?token=... 返回 200 HTML', shop.status === 200 && shop.headers.get('content-type')?.includes('text/html'))
  const ids = ['product-list', 'product-item', 'product-name', 'product-price', 'add-to-cart',
    'search-input', 'search-btn', 'cart-panel', 'cart-count', 'cart-subtotal', 'coupon-input', 'checkout-btn', 'order-total']
  for (const id of ids) {
    check(`商城页存在 [data-testid="${id}"]`, shop.text.includes(`data-testid="${id}"`))
  }
  // 注意：页面里的内联 JS 也含有 data-testid="product-item" 模板字符串，
  // 所以这里只统计「服务端真正渲染出来」的商品节点（带 data-name 属性）。
  const itemCount = (shop.text.match(/data-id="p\d{4}" data-name="/g) ?? []).length
  check('商城页渲染出全部 6 件商品', itemCount === 6, `渲染 ${itemCount} 件`)

  const noToken = await fetch(`${BASE}/shop`, { redirect: 'manual' })
  check('GET /shop 不带 token 时 302 跳回 /', noToken.status === 302 && (noToken.headers.get('location') ?? '') === '/',
    `status=${noToken.status} location=${noToken.headers.get('location')}`)

  // 登录页是原生表单提交（浏览器里点 [data-testid=login-btn] 就是走这条路径）
  const formPost = (body) => fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  })
  const okLogin = await formPost('username=admin&password=123456')
  const okLocation = okLogin.headers.get('location') ?? ''
  check('表单登录成功时 302 跳转 /shop?token=...', okLogin.status === 302 && okLocation.startsWith('/shop?token='),
    `status=${okLogin.status} location=${okLocation}`)
  const shopFromForm = await req(okLocation)
  check('表单登录拿到的 token 能打开商城页', shopFromForm.status === 200 && shopFromForm.text.includes('data-testid="product-list"'))

  const badLogin = await formPost('username=admin&password=nope')
  const badHtml = await badLogin.text()
  check('表单登录失败时回到登录页并显示错误文案',
    badLogin.status === 200 && badHtml.includes('data-testid="login-error"') && badHtml.includes('用户名或密码错误'))
  check('登录失败页不渲染商城内容', !badHtml.includes('data-testid="product-list"'))
}

async function webChecks() {
  console.log('\n[4] Playwright 浏览器流程自检（--web）')

  const browsersPath = fileURLToPath(new URL('../../.playwright-browsers/', import.meta.url))
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath
  const playwrightEntry = new URL('../../node_modules/playwright/index.js', import.meta.url)
  if (!existsSync(playwrightEntry)) {
    bad('未找到 playwright（跳过浏览器自检）', fileURLToPath(playwrightEntry))
    return
  }

  let chromium
  try {
    const mod = await import(playwrightEntry.href)
    chromium = mod.chromium ?? mod.default?.chromium
    if (!chromium) throw new Error('playwright 模块里没有 chromium 导出')
  } catch (error) {
    bad('无法加载 playwright', error.message)
    return
  }

  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    page.setDefaultTimeout(15000)

    // 与平台 Web 用例一致的流程：goto → fill → click → waitForSelector
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
    await page.fill('[data-testid="username"]', 'admin')
    await page.fill('[data-testid="password"]', '123456')
    await page.click('[data-testid="login-btn"]')
    await page.waitForSelector('[data-testid="product-list"]')
    check('登录后跳转到 /shop', page.url().includes('/shop'), page.url())

    await page.fill('[data-testid="search-input"]', '耳机')
    await page.click('[data-testid="search-btn"]')
    await page.waitForSelector('[data-testid="product-item"]')
    const filtered = await page.locator('[data-testid="product-item"]').count()
    check('搜索「耳机」后只显示 1 件商品', filtered === 1, `count=${filtered}`)

    await page.fill('[data-testid="search-input"]', '')
    await page.click('[data-testid="search-btn"]')
    await page.waitForSelector('[data-testid="product-list"]')
    const restored = await page.locator('[data-testid="product-item"]').count()
    check('清空关键字后恢复全部 6 件商品', restored === 6, `count=${restored}`)

    await page.click('[data-testid="add-to-cart"]')
    await page.fill('[data-testid="coupon-input"]', 'SAVE10')
    await page.click('[data-testid="checkout-btn"]')
    await page.waitForSelector('[data-testid="order-total"]')
    const totalText = (await page.locator('[data-testid="order-total"]').first().innerText()).trim()

    // 服务端算出的 total = 59.9 - 6.99 = 52.91；前端缺陷只显示整数 52
    check('【缺陷 4 复现】结算结果只显示整数、不含两位小数',
      totalText.includes('合计') && !/\d+\.\d{2}/.test(totalText), `order-total 文本 = "${totalText}"`)
    check('【缺陷 4 复现】页面没有运费行', !(await page.locator('[data-testid="shipping-row"]').count()))
  } finally {
    await browser.close()
  }
}

const ASSERTION_TYPES = ['status', 'jsonPath', 'bodyContains', 'bodyMatches', 'headerContains', 'responseTime',
  'urlContains', 'elementVisible', 'elementText', 'elementCount']
const ASSERTION_OPS = ['equals', 'notEquals', 'contains', 'notContains', 'matches', 'gt', 'gte', 'lt', 'lte', 'exists', 'truthy']
const CASE_KEYS = ['name', 'type', 'description', 'tags', 'enabled', 'variables', 'steps']
const STEP_KEYS = ['name', 'request', 'extract', 'assertions', 'action', 'screenshot']
const REQUEST_KEYS = ['method', 'url', 'headers', 'query', 'bodyMode', 'body', 'timeoutMs']
const ACTION_KEYS = ['type', 'selector', 'value', 'url', 'ms']
const ASSERTION_KEYS = ['type', 'op', 'path', 'expected', 'name', 'selector']
const EXTRACT_KEYS = ['name', 'from', 'path', 'regex', 'group']

const extraKeys = (obj, allowed) => Object.keys(obj ?? {}).filter((k) => !allowed.includes(k))

/**
 * 校验 cases.json 是否符合平台的导入契约（字段名必须与平台 validateCase 一致）。
 * 这段检查不需要被测服务在运行。
 */
function casesChecks() {
  console.log('\n[1] cases.json 导入契约自检')

  const file = fileURLToPath(new URL('./cases.json', import.meta.url))
  let data
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    bad('cases.json 是合法 JSON', error.message)
    return
  }
  ok('cases.json 是合法 JSON', file)

  check('顶层含 project 与 cases', !!data.project && Array.isArray(data.cases), `cases=${data.cases?.length}`)
  const projectExtra = extraKeys(data.project, ['name', 'description', 'baseUrl', 'variables'])
  check('project 字段名合法（name/description/baseUrl/variables）', projectExtra.length === 0, projectExtra.join(','))
  check('project.baseUrl 指向被测服务 4517 端口', data.project.baseUrl === 'http://127.0.0.1:4517', data.project.baseUrl)

  const cases = data.cases ?? []
  const apiCount = cases.filter((c) => c.type === 'api').length
  const webCount = cases.filter((c) => c.type === 'web').length
  const bugCount = cases.filter((c) => (c.tags ?? []).includes('bug')).length
  console.log(`  ℹ️ 用例统计：共 ${cases.length} 个（API ${apiCount} / Web ${webCount}），标记 bug 的应失败用例 ${bugCount} 个`)

  // 期望：题面「必须包含」清单共 11 条（API 1-8、Web 9-11），其中 4 条会失败
  check('用例数量与必须包含的清单一致（8 API + 3 Web = 11）', cases.length === 11 && apiCount === 8 && webCount === 3,
    `实际 API ${apiCount} / Web ${webCount} / 合计 ${cases.length}`)
  check('应失败的 bug 用例为 4 个（运费、折扣、库存、前端合计）', bugCount === 4, `${bugCount} 个`)

  const problems = []
  const names = []
  for (const [ci, testCase] of cases.entries()) {
    const where = `第 ${ci + 1} 个用例「${testCase.name}」`
    names.push(testCase.name)
    if (extraKeys(testCase, CASE_KEYS).length) problems.push(`${where} 出现多余字段：${extraKeys(testCase, CASE_KEYS).join(',')}`)
    if (typeof testCase.name !== 'string' || !testCase.name.trim()) problems.push(`${where} 缺少 name`)
    if (!['api', 'web'].includes(testCase.type)) problems.push(`${where} type 必须是 api 或 web`)
    if (typeof testCase.description !== 'string') problems.push(`${where} 缺少 description`)
    if (!Array.isArray(testCase.tags)) problems.push(`${where} tags 必须是数组`)
    if (testCase.enabled !== true) problems.push(`${where} enabled 应为 true`)
    if (typeof testCase.variables !== 'object' || testCase.variables === null) problems.push(`${where} variables 必须是对象`)
    if (!Array.isArray(testCase.steps) || !testCase.steps.length) problems.push(`${where} steps 不能为空`)

    const tokenExtractedAt = []
    for (const [si, step] of (testCase.steps ?? []).entries()) {
      const spot = `${where} 第 ${si + 1} 步`
      if (extraKeys(step, STEP_KEYS).length) problems.push(`${spot} 出现多余字段：${extraKeys(step, STEP_KEYS).join(',')}`)
      if (typeof step.name !== 'string' || !step.name.trim()) problems.push(`${spot} 缺少 name`)

      if (testCase.type === 'api') {
        const req = step.request
        if (!req?.url) problems.push(`${spot} 缺少 request.url`)
        else if (extraKeys(req, REQUEST_KEYS).length) problems.push(`${spot} request 出现多余字段：${extraKeys(req, REQUEST_KEYS).join(',')}`)
        if (req && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(String(req.method))) problems.push(`${spot} request.method 非法：${req.method}`)
        if (req?.headers && Object.keys(req.headers).some((k) => k.toLowerCase() === 'authorization')
          && String(req.headers.Authorization ?? req.headers.authorization).includes('{{token}}')
          && !tokenExtractedAt.length) {
          problems.push(`${spot} 使用了 {{token}} 但前面没有 extract token`)
        }
        for (const rule of step.extract ?? []) {
          if (extraKeys(rule, EXTRACT_KEYS).length) problems.push(`${spot} extract 出现多余字段：${extraKeys(rule, EXTRACT_KEYS).join(',')}`)
          if (rule.name === 'token') tokenExtractedAt.push(si)
        }
        // 允许步骤里出现 {{token}} 的位置检查（只会用在 request 上）
        const bodyText = JSON.stringify(req ?? {})
        if (bodyText.includes('{{token}}') && !tokenExtractedAt.length) problems.push(`${spot} 使用了 {{token}} 但前面没有 extract token`)
      } else {
        const action = step.action
        if (!action?.type) problems.push(`${spot} 缺少 action.type`)
        else if (extraKeys(action, ACTION_KEYS).length) problems.push(`${spot} action 出现多余字段：${extraKeys(action, ACTION_KEYS).join(',')}`)
        if (step.request) problems.push(`${spot} Web 用例不应出现 request 字段`)
      }

      if (step.screenshot !== undefined && typeof step.screenshot !== 'boolean') problems.push(`${spot} screenshot 应为布尔值`)

      for (const [ai, a] of (step.assertions ?? []).entries()) {
        const aspot = `${spot} 第 ${ai + 1} 条断言`
        if (extraKeys(a, ASSERTION_KEYS).length) problems.push(`${aspot} 出现多余字段：${extraKeys(a, ASSERTION_KEYS).join(',')}`)
        if (!ASSERTION_TYPES.includes(a.type)) problems.push(`${aspot} type 非法：${a.type}`)
        if (a.op !== undefined && !ASSERTION_OPS.includes(a.op)) problems.push(`${aspot} op 非法：${a.op}`)
        if (a.type === 'jsonPath' && !a.path) problems.push(`${aspot} jsonPath 必须带 path`)
        if (a.type === 'headerContains' && !a.path) problems.push(`${aspot} headerContains 必须带 path=响应头名`)
        if (['elementVisible', 'elementText', 'elementCount'].includes(a.type)) {
          if (!a.selector) problems.push(`${aspot} ${a.type} 必须带 selector`)
          // 平台实现：Web 断言取的是「本步骤 action.selector」解析出来的元素
          else if (a.selector !== step.action?.selector) {
            problems.push(`${aspot} selector 与步骤 action.selector 不一致（平台按 action.selector 解析元素）：${a.selector} != ${step.action?.selector}`)
          }
        }
        if (a.type === 'urlContains' && !a.expected) problems.push(`${aspot} urlContains 必须带 expected`)
      }
    }
  }

  check('所有用例字段名与断言类型/操作符都符合平台契约', problems.length === 0, problems.slice(0, 5).join(' ｜ '))
  if (problems.length > 5) console.log(`  ℹ️ 其余 ${problems.length - 5} 个问题：${problems.slice(5).join(' ｜ ')}`)

  // 每步都断言，用例名不重复
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  check('用例名称不重复', dup.length === 0, dup.join(','))

  // 三个 bug 用例必须都是「多步骤先登录」（6/7/8 用例）
  const multiStepBugs = cases.filter((c) => c.type === 'api' && (c.tags ?? []).includes('bug'))
  check('API bug 用例均为「先登录再下单」的多步骤用例',
    multiStepBugs.every((c) => c.steps.length >= 2 && c.steps[0].extract?.some((e) => e.name === 'token')),
    multiStepBugs.map((c) => `${c.name}:${c.steps.length}步`).join(' '))
}

/**
 * 用**平台自己的执行器**离线跑一遍 cases.json 里的 API 用例（--cases-run）。
 * 这一步验证的不是「被测软件」，而是「用例清单 + 预期失败」在平台引擎下确实成立。
 */
async function platformCaseRun() {
  console.log('\n[5] 用平台执行器离线跑 cases.json 的 API 用例（--cases-run）')

  let runApiCase
  try {
    ({ runApiCase } = await import('../../server/src/runners/api.mjs'))
  } catch (error) {
    bad('无法加载平台执行器（../../server/src/runners/api.mjs）', error.message)
    return
  }

  const data = JSON.parse(readFileSync(fileURLToPath(new URL('./cases.json', import.meta.url)), 'utf8'))
  const { baseUrl, variables } = data.project
  for (const testCase of data.cases.filter((c) => c.type === 'api')) {
    const result = await runApiCase(testCase, { baseUrl, vars: { ...variables, baseUrl }, emit: null })
    const shouldFail = (testCase.tags ?? []).includes('bug')
    const asExpected = shouldFail ? result.status === 'failed' : result.status === 'passed'
    const detail = result.steps
      .flatMap((s) => s.assertions.filter((a) => !a.ok).map((a) => `${s.name}：${a.message}`))
      .join(' ｜ ')
    const label = `${testCase.name} → ${result.status}${shouldFail ? '（预期失败）' : ''}`
    if (asExpected) ok(label, detail.slice(0, 160))
    else bad(label, detail || `预期 ${shouldFail ? 'failed' : 'passed'}`)
  }
}

async function main() {
  console.log(`小商城自检：${BASE}`)
  casesChecks()

  try {
    const { token } = await apiChecks()
    await htmlChecks(token)
  } catch (error) {
    console.error(`\n❌ 自检中断：${error.message}`)
    console.error('   请确认被测服务已启动：node code/examples/demo-app/server.mjs')
    process.exitCode = 1
    return
  }
  if (WITH_WEB) {
    try {
      await webChecks()
    } catch (error) {
      bad('浏览器自检异常', error.message)
    }
  } else {
    console.log('\n[跳过] 浏览器流程自检（加 --web 参数启用）')
  }

  if (WITH_CASES_RUN) {
    await platformCaseRun()
  } else {
    console.log('[跳过] 平台执行器离线跑用例（加 --cases-run 参数启用）')
  }

  console.log(`\n结果：${passed} 项符合预期，${failed} 项不符合预期`)
  process.exitCode = failed ? 1 : 0
}

main()
