# 小商城（demo-app）— 通用软件测试平台的示例被测软件

这是一个**零依赖、故意留有 4 个缺陷**的示例被测目标系统：
同时提供 REST API 和少量服务端渲染的 HTML 页面，用来演示测试平台
「导入示例 → 跑 API/Web 用例 → 看到 4 个失败 → 定位缺陷 → 修复回归」的完整闭环。

- 技术栈：Node.js 内置模块（`node:http` / `node:crypto` / `node:url`），**不需要 `npm install`**
- 默认地址：`http://127.0.0.1:4517`（只监听 `127.0.0.1`）
- 故意埋的缺陷：见 [`BUGS.md`](./BUGS.md)

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `server.mjs` | 被测软件本体：REST API + 登录页 + 商城页（默认端口 4517） |
| `cases.json` | 给测试平台导入的示例项目 + 11 个示例用例（8 API + 3 Web，其中 4 个会失败） |
| `BUGS.md` | 4 个缺陷的清单：位置（文件:行号）、影响、应失败的用例、修复建议 |
| `README.md` | 本文件：启动方式、接口清单、页面选择器、与平台的配合方式 |
| `selfcheck.mjs` | 自检脚本（可选）：校验 cases.json 契约、API 行为、页面选择器，可选跑浏览器流程 |

## 快速上手（3 步）

```powershell
# ① 启动被测软件（前台窗口，日志会实时打印请求）
node code/examples/demo-app/server.mjs
#    [demo-app] 小商城已启动：http://127.0.0.1:4517

# ② 另开一个终端，启动测试平台
cd code
npm start
#    平台默认 http://127.0.0.1:4519
```

③ 打开平台页面 → 左侧「**导入示例**」→ 选「**示例：小商城（含缺陷）**」→ 执行全部用例。
预期结果：**11 个用例，7 通过 / 4 失败**（失败的 4 个都带 `bug` 标签）。

> 也可以用 `--port` / 环境变量换端口：`node code/examples/demo-app/server.mjs` 用 `PORT=4599` 覆盖，
> 平台用 `node server/src/index.mjs --port 4520` 或 `$env:PORT=4520`。

## REST API 一览（全部返回 UTF-8 JSON）

| 方法 | 路径 | 说明 | 可能的响应 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查 | `200 { status: 'ok', time }` |
| POST | `/api/login` | 登录，body `{username, password}` | `200 { token, user: {id,name,role} }` / `401 { error: '用户名或密码错误' }` |
| GET | `/api/products?keyword=` | 商品列表（keyword 为空返回全部，否则按名称包含过滤） | `200 { items: [{id,name,price,stock}], total }` |
| GET | `/api/products/:id` | 商品详情 | `200 {id,name,price,stock}` / `404 { error: '商品不存在' }` |
| POST | `/api/cart/checkout` | 结算下单，**需** `Authorization: Bearer <token>`，body `{items:[{productId,qty}], couponCode?}` | `200 {orderId,items,subtotal,shipping,discount,total,createdAt}` / `401` / `400` |
| GET | `/api/orders/:orderId` | 订单详情，**需** token | `200 订单` / `404 { error: '订单不存在' }` |
| GET | `/api/orders` | 当前用户的订单列表，**需** token | `200 { items: [...] }` |
| GET | `/api/echo?status=500&body=xxx` | **调试接口**：按 query 返回指定状态码/响应体，方便演示各种断言 | 自定义状态码 + `text/plain` |

### 测试账号

| 用户名 | 密码 | 角色 |
| --- | --- | --- |
| `admin` | `123456` | admin |
| `alice` | `alice123` | member |

### 商品数据（价格单位：元）

| ID | 名称 | 价格 | 库存 |
| --- | --- | --- | --- |
| `p1001` | 无线耳机 | 59.9 | 10 |
| `p1002` | 蓝牙音箱 | 129 | 5 |
| `p1003` | 机械键盘 | 299.5 | 3 |
| `p1004` | 人体工学椅 | 899 | 2 |
| `p1005` | 手机支架 | 19.9 | 50 |
| `p1006` | 桌面台灯 | 79 | 0 |

### 结算金额规则

```
subtotal = Σ(price × qty)                        # 保留 2 位小数
shipping = subtotal >= 99 ? 0 : 10               # 正确规则；当前实现恒为 0   ← 缺陷 1
discount = couponCode === 'SAVE10' ? subtotal×0.1 : 0
                                                 # 正确规则；当前实现按 (subtotal+运费)×0.1 算 ← 缺陷 2
qty > stock → 400 { error: '库存不足' }           # 正确规则；当前实现跳过校验  ← 缺陷 3
total = subtotal + shipping - discount           # 保留 2 位小数
```

## HTML 页面与稳定选择器（供 Playwright / Web 用例使用）

| 页面 | 路径 | 关键元素 |
| --- | --- | --- |
| 登录页 | `GET /` | `[data-testid="username"]`、`[data-testid="password"]`(type=password)、`[data-testid="login-btn"]`、`[data-testid="login-error"]`（失败时才显示「用户名或密码错误」） |
| 登录提交 | `POST /login` | 原生表单提交；成功 `302 → /shop?token=...`，失败回显登录页并展示错误文案 |
| 商城页 | `GET /shop?token=...` | `[data-testid="product-list"]`，每件商品：`product-item` / `product-name` / `product-price` / `add-to-cart`；搜索：`search-input` + `search-btn`；购物车：`cart-panel` / `cart-count` / `cart-subtotal` / `coupon-input` / `checkout-btn` / `order-total` |
| 未登录访问商城 | `GET /shop`（无 token 或 token 失效） | `302 → /` |

> 登录页是**原生表单 POST**（点击 `login-btn` 即触发真实导航，服务端 302 到 `/shop?token=...`），
> 这样浏览器自动化不存在「异步跳转竞态」；搜索与结算是页面内 JS（不发导航）。
> **`order-total` 初始隐藏，结算成功后才显示**（`waitForSelector` 会正确地等到它出现）。
>
> 前端缺陷 4：结算后 `order-total` 只显示整数（例如服务端返回 `52.91`，页面显示「合计：52 元」），
> 且不渲染任何运费行。

## 配合测试平台使用

1. **一键导入内置示例（推荐）**：平台左侧「导入示例」→「示例：小商城（含缺陷）」→ 自动创建项目 + 11 个用例。
   （平台读取的就是本目录的 `cases.json`）
2. **手动导入**：平台里「导入 JSON」，选择 `code/examples/demo-app/cases.json`。
3. **按标签过滤执行**：先只跑 `smoke`（应全绿），再只跑 `bug`（应 4 个全红），对比最直观。
4. **变量**：项目变量 `username=admin`、`password=123456`；用例里用 `{{baseUrl}}` / `{{username}}` / `{{password}}` /
   `{{token}}`（`token` 由「登录」步骤 `extract` 出来，供后续步骤使用）。
5. **报告与截图**：Web 用例里带 `"screenshot": true` 的步骤会在失败/执行时自动截图到
   `code/data/runs/<runId>/`，报告里可直接看。

> 执行用例前**必须先启动被测服务**（第 ① 步），否则所有用例都会因为连不上 4517 端口而失败。

## 自检（不依赖平台也能验证）

```powershell
# 终端 A：启动被测服务
node code/examples/demo-app/server.mjs

# 终端 B：跑自检
node code/examples/demo-app/selfcheck.mjs                  # cases.json 契约 + API + 页面选择器
node code/examples/demo-app/selfcheck.mjs --cases-run      # 额外用平台执行器离线跑 8 个 API 用例
node code/examples/demo-app/selfcheck.mjs --web            # 额外用 Playwright 跑一遍浏览器流程
```

自检脚本断言的是「**按 BUGS.md 描述的缺陷行为确实存在**」，因此：
- 未修复状态下应输出 **全部符合预期**（API 用例 5 通过 / 3 失败、Web 用例 1 失败）；
- 如果哪天你把某个缺陷修好了，对应那条「【缺陷 N 复现】」检查会**变成红色** —— 这正是回归信号。

## 常见问题

**Q：平台里所有用例都失败，报连接被拒绝？**
先启动被测服务：`node code/examples/demo-app/server.mjs`，并确认 `cases.json` 里的 `baseUrl` 与实际端口一致。

**Q：4517 端口被占用？**
`$env:PORT=4599; node code/examples/demo-app/server.mjs`，同时把用例项目的 `baseUrl` 改成 `http://127.0.0.1:4599`。

**Q：Web 用例报 Chromium `spawn EPERM` / 起不来？**
这是**受限沙箱**不允许以管道方式启动浏览器进程导致的，与被测软件无关：
请在普通终端（非受限沙箱）里运行平台，或先只跑 API 用例。API 用例不受影响。

**Q：为什么 `cases.json` 里是 11 个用例，而不是题面写的 9 个？**
题面「必须包含」的清单实际编号是 1–11（API 8 个 + Web 3 个），且明确要求其中 4 个失败
（运费 / 折扣 / 库存 / 前端合计）——这 4 个失败用例必须都由清单里的用例承担。
若只保留 9 个，就无法同时覆盖全部清单条目。因此本示例按**编号清单**落地为 11 个用例，
`selfcheck.mjs` 会一并校验这个数量与结构。

**Q：为什么购物车结算后金额没有小数？**
这是**故意的前端缺陷 4**，用于让 Web 用例断言失败，详见 [`BUGS.md`](./BUGS.md)。
