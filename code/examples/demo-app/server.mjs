#!/usr/bin/env node
/**
 * 示例被测软件：小商城（demo-app）
 * ---------------------------------------------------------------------------
 * 这是一个**故意留有缺陷**的被测目标系统，用于演示「通用软件测试平台」的完整流程：
 *   - REST API（前缀 /api，全部返回 UTF-8 JSON）
 *   - 少量服务端渲染的 HTML 页面（供 Playwright 做浏览器自动化测试）
 *
 * 零依赖：只使用 Node 内置模块（node:http / node:crypto）。
 * 启动：node code/examples/demo-app/server.mjs      默认 http://127.0.0.1:4517
 *       PORT=4599 node code/examples/demo-app/server.mjs
 *
 * 故意埋下的 4 个缺陷见同目录 BUGS.md，本文件里用【缺陷 N】注释标出。
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const PORT = Number(process.env.PORT || 4517)
const HOST = process.env.HOST || '127.0.0.1'

// ---------------------------------------------------------------- 内存数据

const USERS = [
  { id: 'u1001', username: 'admin', password: '123456', name: 'admin', role: 'admin' },
  { id: 'u1002', username: 'alice', password: 'alice123', name: 'alice', role: 'member' },
]

const PRODUCTS = [
  { id: 'p1001', name: '无线耳机', price: 59.9, stock: 10 },
  { id: 'p1002', name: '蓝牙音箱', price: 129, stock: 5 },
  { id: 'p1003', name: '机械键盘', price: 299.5, stock: 3 },
  { id: 'p1004', name: '人体工学椅', price: 899, stock: 2 },
  { id: 'p1005', name: '手机支架', price: 19.9, stock: 50 },
  { id: 'p1006', name: '桌面台灯', price: 79, stock: 0 },
]

/** token -> user */
const tokens = new Map()
/** 订单列表（内存） */
const orders = []

// ---------------------------------------------------------------- 小工具

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const findProduct = (id) => PRODUCTS.find((p) => p.id === id)

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8')
  res.writeHead(status, { 'content-type': type, 'content-length': body.length })
  res.end(body)
}

function redirect(res, location) {
  res.writeHead(302, { location, 'content-type': 'text/plain; charset=utf-8' })
  res.end(`正在跳转到 ${location}`)
}

/** 读取请求体（上限 1MB），返回原始字符串。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

/** 从 Authorization 头解析当前登录用户，未登录返回 null。 */
function currentUser(req) {
  const raw = String(req.headers.authorization ?? '').trim()
  const match = /^Bearer\s+(.+)$/i.exec(raw)
  if (!match) return null
  return tokens.get(match[1].trim()) ?? null
}

// ---------------------------------------------------------------- 结算规则

/**
 * 运费规则（正确规则）：满 99 元免运费，否则 10 元。
 * 注意：这个函数算出来的「真实运费」只被折扣计算用到，
 *       响应里的 shipping 字段恒为 0（见【缺陷 1】）。
 */
function calcShipping(subtotal) {
  return subtotal >= 99 ? 0 : 10
}

function productItemHtml(product) {
  return (
    '<div class="product" data-testid="product-item" data-id="' + product.id + '"' +
    ' data-name="' + product.name + '" data-price="' + product.price + '">' +
    '<div class="pname" data-testid="product-name">' + product.name + '</div>' +
    '<div class="pprice" data-testid="product-price">￥' + product.price.toFixed(2) + '</div>' +
    '<div class="pstock">库存 ' + product.stock + ' 件</div>' +
    '<button type="button" data-testid="add-to-cart" data-id="' + product.id + '">加入购物车</button>' +
    '</div>'
  )
}

// ---------------------------------------------------------------- 页面

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
         background: #f4f6f9; color: #1f2937; }
  header { background: #ff6a00; color: #fff; padding: 14px 24px; display: flex;
           align-items: center; justify-content: space-between; }
  header h1 { margin: 0; font-size: 20px; letter-spacing: 1px; }
  header .who { font-size: 13px; opacity: .9; }
  main { max-width: 1080px; margin: 24px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 10px; padding: 24px; box-shadow: 0 1px 6px rgba(0,0,0,.08); }
  .login-wrap { max-width: 380px; margin: 60px auto; }
  label { display: block; margin-bottom: 14px; font-size: 14px; color: #374151; }
  input { width: 100%; margin-top: 6px; padding: 10px 12px; border: 1px solid #d1d5db;
          border-radius: 6px; font-size: 14px; }
  button { background: #ff6a00; color: #fff; border: 0; border-radius: 6px;
           padding: 9px 16px; font-size: 14px; cursor: pointer; }
  button:hover { background: #e85f00; }
  .err { color: #dc2626; font-size: 13px; margin-top: 10px; }
  .toolbar { display: flex; gap: 10px; margin-bottom: 18px; }
  .toolbar input { flex: 1; margin: 0; }
  .layout { display: flex; gap: 20px; align-items: flex-start; }
  .list { flex: 3; }
  .cart { flex: 2; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; }
  .product { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px; }
  .product .pname { font-weight: 600; margin-bottom: 6px; }
  .product .pprice { color: #ff6a00; font-size: 18px; font-weight: 700; }
  .product .pstock { color: #6b7280; font-size: 12px; margin: 6px 0 10px; }
  .cart h2, .list h2 { margin: 0 0 14px; font-size: 16px; }
  .cart .row { display: flex; justify-content: space-between; padding: 8px 0;
               border-bottom: 1px dashed #e5e7eb; font-size: 14px; }
  .cart .row span:last-child { font-weight: 600; }
  .order-total { margin-top: 14px; padding: 12px; background: #fff7ed; border: 1px solid #fed7aa;
                 border-radius: 8px; font-size: 16px; font-weight: 700; color: #c2410c; }
  .empty { color: #9ca3af; padding: 20px; text-align: center; }
  .tip { color: #6b7280; font-size: 12px; margin-top: 8px; }
`

const PAGE_JS_COMMON = `
  function byTestId(id) { return document.querySelector('[data-testid="' + id + '"]'); }
`

/**
 * 登录页 GET /
 * 表单用**原生 POST**提交到 /login，服务端校验后 302 跳到 /shop?token=...
 * （对浏览器自动化更友好：点击即触发真实导航，不存在异步跳转竞态。）
 */
function loginPage(errorText = '') {
  const errorHtml = errorText
    ? `<div class="err" data-testid="login-error">${errorText}</div>`
    : '<div class="err" data-testid="login-error" hidden></div>'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小商城 · 登录</title>
<style>${CSS}</style>
</head>
<body>
<header><h1>小商城</h1><div class="who">示例被测软件 · demo-app</div></header>
<main>
  <div class="card login-wrap">
    <h2 style="margin-top:0">账号登录</h2>
    <form id="login-form" method="post" action="/login" autocomplete="off">
      <label>用户名
        <input data-testid="username" name="username" placeholder="admin">
      </label>
      <label>密码
        <input data-testid="password" name="password" type="password" placeholder="123456">
      </label>
      <button data-testid="login-btn" type="submit">登录</button>
    </form>
    ${errorHtml}
    <div class="tip">可用账号：admin / 123456，alice / alice123</div>
  </div>
</main>
</body>
</html>`
}

/** 商城页 GET /shop?token=... */
function shopPage(user, token) {
  const items = PRODUCTS.map(productItemHtml).join('\n        ')
  const clientJs = `
(function () {
${PAGE_JS_COMMON}
  var TOKEN = __TOKEN__;
  var PRODUCTS = __PRODUCTS__;
  var cart = [];
  var listEl = byTestId('product-list');

  function itemHtml(p) {
    return '<div class="product" data-testid="product-item" data-id="' + p.id + '"' +
      ' data-name="' + p.name + '" data-price="' + p.price + '">' +
      '<div class="pname" data-testid="product-name">' + p.name + '</div>' +
      '<div class="pprice" data-testid="product-price">￥' + p.price.toFixed(2) + '</div>' +
      '<div class="pstock">库存 ' + p.stock + ' 件</div>' +
      '<button type="button" data-testid="add-to-cart" data-id="' + p.id + '">加入购物车</button>' +
      '</div>';
  }

  function addToCart(id) {
    var p = null;
    for (var i = 0; i < PRODUCTS.length; i++) { if (PRODUCTS[i].id === id) { p = PRODUCTS[i]; } }
    if (!p) { return; }
    var line = null;
    for (var j = 0; j < cart.length; j++) { if (cart[j].productId === id) { line = cart[j]; } }
    if (line) { line.qty += 1; } else { cart.push({ productId: id, name: p.name, price: p.price, qty: 1 }); }
    renderCart();
  }

  function renderCart() {
    var count = 0;
    var subtotal = 0;
    for (var i = 0; i < cart.length; i++) {
      count += cart[i].qty;
      subtotal += cart[i].price * cart[i].qty;
    }
    byTestId('cart-count').textContent = String(count);
    byTestId('cart-subtotal').textContent = subtotal.toFixed(2);
  }

  function doSearch() {
    var keyword = byTestId('search-input').value.trim();
    var html = '';
    var hits = 0;
    for (var i = 0; i < PRODUCTS.length; i++) {
      if (!keyword || PRODUCTS[i].name.indexOf(keyword) >= 0) { html += itemHtml(PRODUCTS[i]); hits++; }
    }
    listEl.innerHTML = hits ? html : '<div class="empty" data-testid="empty-tip">没有找到相关商品</div>';
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) { return; }
    var addBtn = target.closest('[data-testid="add-to-cart"]');
    if (addBtn) { addToCart(addBtn.getAttribute('data-id')); return; }
    if (target.closest('[data-testid="search-btn"]')) { doSearch(); return; }
    if (target.closest('[data-testid="checkout-btn"]')) { checkout(); return; }
  });

  byTestId('search-input').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') { event.preventDefault(); doSearch(); }
  });

  function checkout() {
    var box = byTestId('order-total');
    if (!cart.length) {
      box.textContent = '购物车是空的，请先加入商品';
      box.hidden = false;
      return;
    }
    var payload = { items: [] };
    for (var i = 0; i < cart.length; i++) {
      payload.items.push({ productId: cart[i].productId, qty: cart[i].qty });
    }
    var coupon = byTestId('coupon-input').value.trim();
    if (coupon) { payload.couponCode = coupon; }

    fetch('/api/cart/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!r.ok) {
        box.textContent = '下单失败：' + ((r.data && r.data.error) || '未知错误');
        box.hidden = false;
        return;
      }
      // 【缺陷 4】前端只把 total 的整数部分渲染出来，而且完全不显示运费行。
      // 正确实现应显示 data.total.toFixed(2)（例如「合计：52.91 元」）并展示运费明细。
      var shown = Math.trunc(Number(r.data.total));
      box.textContent = '合计：' + shown + ' 元';
      box.hidden = false;
    }).catch(function () {
      box.textContent = '下单失败：网络异常';
      box.hidden = false;
    });
  }

  renderCart();
})();
`
    .replace('__TOKEN__', JSON.stringify(token))
    .replace('__PRODUCTS__', JSON.stringify(PRODUCTS))

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>小商城 · 商城</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>小商城</h1>
  <div class="who">当前用户：${user.name}（${user.role}）</div>
</header>
<main>
  <div class="layout">
    <section class="list">
      <div class="toolbar">
        <input data-testid="search-input" placeholder="输入商品关键字，如：耳机">
        <button data-testid="search-btn" type="button">搜索</button>
      </div>
      <h2>商品列表</h2>
      <div class="grid" data-testid="product-list">
        ${items}
      </div>
    </section>
    <aside class="cart">
      <div class="card" data-testid="cart-panel">
        <h2>购物车</h2>
        <div class="row"><span>商品件数</span><span data-testid="cart-count">0</span></div>
        <div class="row"><span>商品小计（元）</span><span data-testid="cart-subtotal">0.00</span></div>
        <label style="margin-top:14px">优惠券
          <input data-testid="coupon-input" placeholder="如 SAVE10">
        </label>
        <button data-testid="checkout-btn" type="button">结算</button>
        <div class="order-total" data-testid="order-total" hidden></div>
        <div class="tip">优惠券 SAVE10：按商品小计打 9 折</div>
      </div>
    </aside>
  </div>
</main>
<script>${clientJs}</script>
</body>
</html>`
}

// ---------------------------------------------------------------- 业务处理

function handleLogin(req, res) {
  return readJson(req).then((body) => {
    const username = String(body?.username ?? '').trim()
    const password = String(body?.password ?? '')
    const user = USERS.find((u) => u.username === username && u.password === password)
    if (!user) {
      sendJson(res, 401, { error: '用户名或密码错误' })
      return
    }
    const token = randomUUID()
    tokens.set(token, user)
    sendJson(res, 200, { token, user: { id: user.id, name: user.name, role: user.role } })
  }).catch(() => sendJson(res, 400, { error: '请求体不是合法 JSON' }))
}

/** 登录页表单提交（application/x-www-form-urlencoded），成功则 302 到 /shop?token=... */
function handleLoginForm(req, res) {
  return readBody(req).then((raw) => {
    const form = new URLSearchParams(raw)
    const username = String(form.get('username') ?? '').trim()
    const password = String(form.get('password') ?? '')
    const user = USERS.find((u) => u.username === username && u.password === password)
    if (!user) {
      sendHtml(res, 200, loginPage('用户名或密码错误'))
      return
    }
    const token = randomUUID()
    tokens.set(token, user)
    redirect(res, `/shop?token=${encodeURIComponent(token)}`)
  }).catch(() => sendHtml(res, 200, loginPage('用户名或密码错误')))
}

function handleProducts(res, url) {
  const keyword = String(url.searchParams.get('keyword') ?? '').trim()
  const items = PRODUCTS
    .filter((p) => !keyword || p.name.includes(keyword))
    .map((p) => ({ id: p.id, name: p.name, price: p.price, stock: p.stock }))
  sendJson(res, 200, { items, total: items.length })
}

function handleProductDetail(res, id) {
  const product = findProduct(id)
  if (!product) {
    sendJson(res, 404, { error: '商品不存在' })
    return
  }
  sendJson(res, 200, { id: product.id, name: product.name, price: product.price, stock: product.stock })
}

function handleCheckout(req, res, user) {
  return readJson(req).then((body) => {
    const rawItems = Array.isArray(body?.items) ? body.items : []
    if (!rawItems.length) {
      sendJson(res, 400, { error: '购物车为空' })
      return
    }

    const items = []
    let subtotal = 0
    for (const raw of rawItems) {
      const product = findProduct(String(raw?.productId ?? ''))
      if (!product) {
        sendJson(res, 400, { error: `商品不存在：${raw?.productId}` })
        return
      }
      const qty = Number(raw?.qty ?? 0)
      if (!Number.isFinite(qty) || qty <= 0) {
        sendJson(res, 400, { error: '购买数量必须大于 0' })
        return
      }

      // 【缺陷 3】这里应当校验库存：qty > product.stock 时返回
      //   400 { error: '库存不足' }。示例软件故意跳过了这段校验，于是超量下单照样成功。

      const amount = round2(product.price * qty)
      subtotal = round2(subtotal + amount)
      items.push({ productId: product.id, name: product.name, price: product.price, qty, amount })
    }

    // 【缺陷 1】响应里的 shipping 被写死为 0：
    //   正确实现应为 const shipping = calcShipping(subtotal)（满 99 免运费，否则 10 元）。
    const shipping = 0

    // 【缺陷 2】折扣基数错误地使用了 (subtotal + 真实运费)，
    //   正确实现应为 discount = subtotal * 0.1。
    const couponCode = String(body?.couponCode ?? '').trim().toUpperCase()
    const discountBase = subtotal + calcShipping(subtotal)
    const discount = couponCode === 'SAVE10' ? round2(discountBase * 0.1) : 0

    const total = round2(subtotal + shipping - discount)
    const order = {
      orderId: `o${randomUUID().slice(0, 8)}`,
      userId: user.id,
      items,
      subtotal,
      shipping,
      discount,
      total,
      couponCode: couponCode || null,
      createdAt: new Date().toISOString(),
    }
    orders.push(order)

    sendJson(res, 200, {
      orderId: order.orderId,
      items: order.items,
      subtotal: order.subtotal,
      shipping: order.shipping,
      discount: order.discount,
      total: order.total,
      createdAt: order.createdAt,
    })
  }).catch(() => sendJson(res, 400, { error: '请求体不是合法 JSON' }))
}

function handleOrderDetail(res, user, orderId) {
  const order = orders.find((o) => o.orderId === orderId)
  if (!order || order.userId !== user.id) {
    sendJson(res, 404, { error: '订单不存在' })
    return
  }
  sendJson(res, 200, order)
}

function handleOrderList(res, user) {
  const items = orders.filter((o) => o.userId === user.id).slice().reverse()
  sendJson(res, 200, { items })
}

// ---------------------------------------------------------------- 路由

async function route(req, res, url) {
  const { pathname } = url
  const method = req.method.toUpperCase()

  // ---- HTML 页面
  if (method === 'GET' && pathname === '/') {
    sendHtml(res, 200, loginPage())
    return
  }
  if (method === 'GET' && pathname === '/shop') {
    const token = String(url.searchParams.get('token') ?? '').trim()
    const user = token ? tokens.get(token) : null
    if (!user) {
      redirect(res, '/')
      return
    }
    sendHtml(res, 200, shopPage(user, token))
    return
  }
  if (method === 'POST' && pathname === '/login') {
    await handleLoginForm(req, res)
    return
  }
  if (method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204)
    res.end()
    return
  }

  // ---- REST API
  if (!pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: `接口不存在：${method} ${pathname}` })
    return
  }

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { status: 'ok', time: new Date().toISOString() })
    return
  }

  // 调试用：GET /api/echo?status=500&body=xxx
  if (method === 'GET' && pathname === '/api/echo') {
    const rawStatus = url.searchParams.get('status')
    const status = rawStatus === null ? 200 : Number(rawStatus)
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      sendJson(res, 400, { error: `非法状态码：${rawStatus}` })
      return
    }
    sendText(res, status, url.searchParams.get('body') ?? '')
    return
  }

  if (method === 'POST' && pathname === '/api/login') {
    await handleLogin(req, res)
    return
  }

  if (method === 'GET' && pathname === '/api/products') {
    handleProducts(res, url)
    return
  }

  const productMatch = /^\/api\/products\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && productMatch) {
    handleProductDetail(res, decodeURIComponent(productMatch[1]))
    return
  }

  if (method === 'POST' && pathname === '/api/cart/checkout') {
    const user = currentUser(req)
    if (!user) {
      sendJson(res, 401, { error: '未登录或登录已过期' })
      return
    }
    await handleCheckout(req, res, user)
    return
  }

  if (method === 'GET' && pathname === '/api/orders') {
    const user = currentUser(req)
    if (!user) {
      sendJson(res, 401, { error: '未登录或登录已过期' })
      return
    }
    handleOrderList(res, user)
    return
  }

  const orderMatch = /^\/api\/orders\/([^/]+)$/.exec(pathname)
  if (method === 'GET' && orderMatch) {
    const user = currentUser(req)
    if (!user) {
      sendJson(res, 401, { error: '未登录或登录已过期' })
      return
    }
    handleOrderDetail(res, user, decodeURIComponent(orderMatch[1]))
    return
  }

  sendJson(res, 404, { error: `接口不存在：${method} ${pathname}` })
}

// ---------------------------------------------------------------- 启动

const server = createServer((req, res) => {
  const startedAt = Date.now()
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
  res.on('finish', () => {
    // 请求日志：形如 [demo-app] GET /api/products 200 3ms
    console.log(`[demo-app] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - startedAt}ms`)
  })
  route(req, res, url).catch((error) => {
    if (!res.headersSent) sendJson(res, 500, { error: `服务器内部错误：${error.message}` })
    else res.end()
  })
})

// 只有在「直接运行本文件」时才监听端口，被 import 时不会占端口。
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  server.listen(PORT, HOST, () => {
    console.log(`[demo-app] 小商城已启动：http://${HOST}:${PORT}`)
  })
}

export { server, PRODUCTS }
