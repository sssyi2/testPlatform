# 测试平台（TestPlatform）

一个可本机运行的**通用软件测试平台**：声明式地描述测试用例，一键执行，实时看日志与断言，
自动产出带截图证据的 HTML 报告，可以在浏览器里管理项目和用例。

- **API / HTTP 接口测试**：请求编排、变量抽取（如登录拿 token）、状态码 / JSON 取值 / 响应体 / 响应头 / 耗时断言。
- **Web UI 测试**：Playwright 驱动 Chromium，页面动作 + 元素断言，失败自动截图。
- **可测任意软件**：只要能通过 HTTP 或网页访问，就能被测；平台自带一个「有缺陷的示例商城」用于自证效果。

> 📘 想弄清**平台是怎么实现的、用了哪些测试方法**：看 `code/docs/平台实现与测试方法.md`
> （架构分层、执行时序、断言清单、15 种测试方法与用例设计技术、平台自身的四层验证、扩展方式、局限）。

---

## 1. 目录结构

```
testPlatform/
├─ readme.md                  ← 本文件：平台使用说明
├─ AGENTS.md                  ← 工作区铁律（含「每轮对话自动归档」约定）
├─ code/                      ← 平台全部代码
│  ├─ server/src/             ← 后端：REST API + 执行引擎 + 报告
│  │  ├─ index.mjs            ← 服务入口（路由、SSE、静态托管）
│  │  ├─ runner.mjs           ← 执行编排（事件广播、进度落盘、取消）
│  │  ├─ runners/api.mjs      ← API 用例执行器
│  │  ├─ runners/web.mjs      ← Web 用例执行器（Playwright）
│  │  ├─ assertions.mjs       ← 断言引擎
│  │  ├─ vars.mjs             ← 变量插值 / JSON 取值
│  │  ├─ store.mjs            ← JSON 数据层
│  │  ├─ report.mjs           ← 自包含 HTML 报告
│  │  └─ http.mjs             ← 极简 HTTP 工具层
│  ├─ web/                    ← 前端：React + Vite + TypeScript
│  │  ├─ index.html
│  │  └─ src/                 ← 界面源码（项目/用例/执行/报告）
│  ├─ examples/demo-app/      ← 示例**被测软件**（故意留了 4 个缺陷）
│  ├─ tools/                  ← 命令行工具（启动、演示、自测、归档）
│  ├─ docs/                   ← 实现说明与测试方法文档
│  ├─ data/                   ← 运行时数据：projects/cases、执行记录、截图
│  ├─ vite.config.ts / tsconfig.json / package.json
│  └─ .playwright-browsers/   ← Chromium（装在本目录内，不污染系统）
├─ video/                     ← 平台成功运行的录像 + 录像说明
└─ prompt/                    ← 与本项目相关的完整对话记录（自动归档）
```

---

## 2. 安装

前置条件：**Node.js ≥ 20**（本机为 v24）。

```powershell
cd E:\testPlatform\code

# 1) 安装依赖（React/Vite/Playwright）
#    注意：本机 npm 全局缓存目录在工作区外，需要把缓存指到工作区内（code\.npmrc 已写好，
#    但环境变量会覆盖它，所以显式传 --cache 最稳）
$env:npm_config_cache = "$PWD\.npm-cache"
node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install --ignore-scripts

# 2) 安装 Chromium（Web UI 用例需要；装到 code\.playwright-browsers）
node tools\install-browsers.mjs

# 3) 构建前端
node node_modules\vite\bin\vite.js build
```

> `--ignore-scripts` 是为了跳过第三方包的 postinstall 脚本（更安全；本平台的依赖不依赖它们）。
> 终端里如果 `npm` 命令本身可用，也可以直接 `npm install --ignore-scripts`。

---

## 3. 快速上手（推荐先跑一遍演示）

```powershell
cd E:\testPlatform\code
node tools\demo.mjs --once     # 一键：启动示例被测软件 → 导入示例用例 → 执行 → 打印结果与报告地址
node tools\verify-all.mjs      # 完整验收：API 层自测 + 真实浏览器界面自测（逐步截图）
node tools\selftest.mjs        # 只跑 API 层自测（退出码 0 表示通过，适合 CI）
node tools\sse-contract.mjs    # 校验实时事件流（SSE）契约
```

演示环境（录屏用，会打开浏览器但不自动执行）：

```powershell
powershell -ExecutionPolicy Bypass -File tools\start.ps1
```

---

## 4. 日常使用

```powershell
cd E:\testPlatform\code

# 开发模式（前端热更新 + 后端 API）
npm run dev            # 界面 http://127.0.0.1:4518，API http://127.0.0.1:4519

# 生产模式（先构建前端，再由后端一起托管）
npm run build
npm start              # 界面 http://127.0.0.1:4519
```

界面里可以完成全部操作：

1. **导入示例** → 左侧「导入示例」按钮，选择 `demo-app`，即可得到 11 个示例用例（8 个 API + 3 个 Web）。
2. **运行**：勾选用例 → 「运行选中」；或直接「全部运行」。
3. **看执行**：执行面板会通过 SSE 实时滚动显示每个用例、每个步骤的日志与断言结果，
   失败会自动截图（Web 用例），点缩略图可放大。
4. **看报告**：执行记录里点「打开 HTML 报告」，得到一个自包含的 `.html`（内联截图），可直接分享或存档。
5. **写自己的用例**：新建用例 → 选类型（API / Web）→ 加步骤 → 加断言 → 保存 → 运行。

### 用例写法要点

- **变量**：`{{baseUrl}}`（项目里配置）、自定义变量（项目级 / 用例级 / 执行时覆盖），
  以及内置动态变量 `{{$timestamp}}`、`{{$isoDate}}`、`{{$date}}`、`{{$uuid}}`、`{{$randomInt}}`。
- **变量抽取（串联登录态）**：API 步骤里可写抽取规则，例如从 `$.token` 抽出 `token`，
  后续步骤用 `Authorization: Bearer {{token}}`。
- **断言**：`status` / `jsonPath` / `bodyContains` / `bodyMatches` / `headerContains` / `responseTime`（API），
  `urlContains` / `elementVisible` / `elementText` / `elementCount`（Web）。
  比较符：`equals`、`notEquals`、`contains`、`notContains`、`matches`、`gt/gte/lt/lte`、`exists`、`truthy`。
- **失败控制**：单个步骤可勾选「失败后继续」，方便一次跑出全部问题。
- **预期失败（xfail）**：给「已知缺陷」用例打上预期失败标记后，它失败时记为
  **预期失败**（不算整次执行失败，CI 不会因已知缺陷而红），反而通过时记为
  **意外通过**（提示缺陷可能已修复，该更新用例了）。报告里两种结论都有独立标记。

### 用命令行驱动（CI 友好）

```powershell
# 导入示例项目并执行全部用例，打印结果
node tools\demo.mjs --once

# 完整验收：API 层自测 + 真实浏览器界面自测（逐步截图到 code\data\ui-shots）
node tools\verify-all.mjs

# 只跑 API 层自测（退出码可直接用于 CI）
node tools\selftest.mjs

# 校验实时事件流（SSE）契约
node tools\sse-contract.mjs

# 导出执行报告为自包含 HTML（CI 归档 / 发送邮件）
node tools\export-report.mjs            # 最近一次
node tools\export-report.mjs run_xxxx   # 指定执行
```

REST API 一览（全部返回 JSON，`/api` 前缀）：`health`、`projects`(CRUD)、`projects/:id/cases`、`cases/:id`(CRUD)、
`runs`(创建/列表/详情/取消/删除)、`runs/:id/events`(SSE 实时事件)、`runs/:id/report`(HTML 报告)、
`artifacts/:runId/:file`(截图)、`import`/`export`(用例导入导出)、`examples`(示例清单/一键导入)。

---

## 5. 示例被测软件（用来验证平台本身）

`code/examples/demo-app/` 是一个零依赖的「小商城」，同时提供 REST API 与网页：

```powershell
node code\examples\demo-app\server.mjs     # http://127.0.0.1:4517
```

它**故意**留了 4 个缺陷（详见 `code/examples/demo-app/BUGS.md`），所以 11 个示例用例里
**有 4 个注定失败**——这正是演示平台「测出问题」的能力。

### 实测结果（可复现）

`node tools\verify-all.mjs` 的真实输出（本机实测）：

| 用例 | 类型 | 结果 | 说明 |
| --- | --- | --- | --- |
| 健康检查接口可用 | API | ✅ 通过 | `status=200`、`$.status=ok`、耗时 < 3s |
| 登录成功并返回令牌 | API | ✅ 通过 | 抽取 `$.token` 供后续步骤使用 |
| 登录失败返回 401 与错误提示 | API | ✅ 通过 | 断言 `$.error` 文案 |
| 按关键字搜索商品 | API | ✅ 通过 | 查询参数 + JSONPath |
| 商品详情返回 404 当商品不存在 | API | ✅ 通过 | 负向用例 |
| 小额订单应收取运费 | API | ❌ **测出缺陷 1** | 期望 `shipping=10`，实际 `0`（漏收运费） |
| 优惠券应按商品小计计算折扣 | API | ❌ **测出缺陷 2** | 期望 `discount=5.99`，实际 `6.99`（折扣基数含运费） |
| 库存不足应拒绝下单 | API | ❌ **测出缺陷 3** | 期望 `400 库存不足`，实际 `200`（跳过库存校验） |
| 登录后进入商城 | Web | ✅ 通过 | 真实 Chromium：填表 → 点登录 → 跳转 `/shop` |
| 搜索商品过滤列表 | Web | ✅ 通过 | 元素数量断言 |
| 结算合计金额显示正确 | Web | ❌ **测出缺陷 4** | 期望两位小数，实际「合计：52 元」（前端截断取整），并自动截图 |

**汇总：11 个用例，7 通过 / 4 失败 / 0 异常**，失败处逐条给出「期望 vs 实际」，
Web 失败自动截图，报告可一键导出为自包含 HTML。

样本产物：

- 执行记录与截图：`code/data/runs/`（含 `*-fail.png` 失败截图）
- 导出的报告：`code/data/reports/run_*.html`（内联截图，可直接用浏览器打开）
- 界面验收截图：`code/data/ui-shots/`（01 首页 → 06 报告）

---

## 6. 录像

`video/` 存放平台成功运行、对被测软件完成测试的录像，命名与说明见 `video/README.md`。

现有成品：`video/20261125-小商城示例-全流程测试.mp4`（50.8 秒，11 个用例 7 通过 / 4 失败，
配套 `-报告.html` 与 `-封面.jpg`）。重新录制一条：

```powershell
cd code
node tools\record-demo.mjs            # 自动操作界面 + 录制 + 转 mp4 + 生成说明
```

脚本用独立端口（4521）与独立数据目录（`code/.recording-data`），**不会影响**你正在使用的平台实例。

---

## 7. 对话过程归档（prompt/）

`prompt/` 保存本项目的完整人机对话记录，**自动生成**：

| 目录/文件 | 内容 |
| --- | --- |
| `prompt/INDEX.md` | 索引：主对话在第一张表，子代理会话在第二张表 |
| `prompt/对话正文/<时间>-<标题>.md` | ★**人类消息 + 助手回复正文 + 助手↔子代理往来消息，每条都署名**，最常看的就是这个 |
| `prompt/会话全文/<时间>-<标题>.md` | 完整过程（工具调用、思考过程、命令输出，长内容有截断提示） |
| `prompt/原始事件/<会话ID>.jsonl` | 原始事件流，完全保真 |

`prompt/对话正文/` 里每条消息都有明确署名，用来分辨「到底是谁说的」：

| 署名 | 谁发的 |
| --- | --- |
| `👤 用户（本人）` | **你**，在 GUI 里亲手发的 |
| `🤖 助手` | 助手（我）的回复正文 |
| `🧑💻 助手 → 子代理` | **助手**派给子代理的委派任务 / 追加消息（**不是人发的**） |
| `📨 代理间消息（不是人发的）` | 子代理汇报等代理之间中转的消息（**不是人发的**） |

> 为什么必须署名：DSH 里**子代理会话**的「用户消息」其实是主代理（助手）发过去的委派提示，
> 数据结构上同样标成 `source.kind = "user"`。不区分会话身份就会把「你是一个前端工程师…」
> 这种助手派活误标成「用户」。

归档来源是 DSH 落盘的会话日志（`$DSH_HOME/sessions/<项目>/<会话>/session.v<N>.jsonl.zstd`，
由 `code/tools/dsh-archive.mjs` 解码生成；**自动取版本号最大的那个文件**，当前是 v4）。按重要性排序：

1. **宿主插件 `dsh-archive-watch`（主力，装一次永久生效）**
   它是 profile 里的一行宿主插件，**随 GUI 启动自动运行**，不需要再手动启动任何脚本。
   已装进 `web` 与 `desktop` 两个 profile（桌面版 GUI 跑的是 `desktop`）。
   机制：监听宿主的 `session/event`，每轮把话说完后静默 3 秒即归档；另有 60 秒兜底轮询，
   事件监听万一失效也不会漏。运行日志见 `prompt/.archive-watch.log`。
   插件源码：`C:\Users\sfy\.dsh\plugins\dsh-archive-watch`（安装/卸载见该目录 `README.md`）。
2. `AGENTS.md` 铁律：每轮开始/结束各跑一次 `node code/tools/dsh-archive.mjs --quiet`
3. hook 双保险（可选）：`.dsh/hooks.json` → 用 `dsh web --patch .dsh/profile-patch.yml` 启动时，
   在 UserPromptSubmit / Stop 各归档一次
4. 手动重生成：`node code/tools/dsh-archive.mjs --force`
5. 应急：若日志超过 1 分钟不再更新（说明插件没生效），手动拉起
   `code/tools/archive-watch.ps1`，它就又变成常驻守护进程。

> 为什么必须有第 1 条这类常驻机制：助手的回复是在**本轮最后一次工具调用之后**才生成的，
> 回合内运行的归档看不到它；两回合之间没有东西在跑时，这段内容会晚一个回合才出现。

> **DSH 升级后请自查一次归档**：升级会改会话日志格式版本（例如 v3 → v4，旧文件原地冻结）。
> 跑 `node code/tools/dsh-archive.mjs --list` 看是否还认得到会话，再跑一次不带 `--quiet` 的
> 归档看是否出现「本次更新 N 个会话」。脚本若静默地只读过期日志，界面上一切正常但新对话不会进档。

---

## 8. 常见问题

| 现象 | 处理 |
| --- | --- |
| 界面打不开、只有一段文字 | 前端没构建：`npm run build`（或 `node node_modules\vite\bin\vite.js build`） |
| Web 用例报「Chromium 启动失败」 | 先 `node tools\install-browsers.mjs`；确认 `code\.playwright-browsers` 下有 `chromium-*` |
| 报 `spawn EPERM` / 权限错误 | 说明当前终端被受限沙箱包裹，换系统自带终端（或带完整权限）重跑 |
| npm 报 `EPERM ... npm-cache` | 缓存目录在工作区外：加 `--cache "$PWD\.npm-cache"` |
| 端口被占用 | `$env:PORT=4520; npm start`（演示脚本另支持 `PLATFORM_PORT` / `DEMO_PORT`） |
| 想清空数据重新开始 | 删除 `code\data\`（项目、用例、执行记录、截图都在里面） |
