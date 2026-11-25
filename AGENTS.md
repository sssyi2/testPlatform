# AGENTS.md — 软件测试平台（testPlatform）

本文件由 DSH 在**每个新会话**自动加载。任何模型/助手在本工作区工作时，都必须遵守这里的约定。

## 1. 项目目标

在 `E:\testPlatform` 里构建一个**通用软件测试平台**：能对任意被测软件（Web 应用、HTTP 接口、
命令行程序等）定义并执行测试用例、采集结果、生成报告，并把成功运行的演示过程录制下来。

## 2. 目录结构与职责

| 路径 | 职责 | 谁维护 |
| --- | --- | --- |
| `readme.md` | 平台使用说明（安装、启动、编写用例、查看报告、录屏位置） | 助手维护，随功能更新 |
| `code/` | 平台全部代码（源码、脚本、示例用例、依赖清单） | 助手维护 |
| `video/` | 平台成功运行、对真实软件完成测试的录像（含录像说明） | 助手录制并登记 |
| `prompt/` | 与本项目相关的**完整人机对话记录**（自动归档，来源是 DSH 会话日志） | 只能由 `code/tools/dsh-archive.mjs` 写入 |
| `AGENTS.md` | 本文件：工作区铁律 | 助手维护 |
| `.dsh/` | DSH 自动化配置（hook 定义、profile 补丁） | 助手维护 |
| `~\.dsh\plugins\dsh-archive-watch\` | **自动归档宿主插件**（工作区外：装进 web 与 desktop 两个 profile，随 GUI 启动生效） | 助手维护 |
| `~\.dsh\profiles\web\` / `~\.dsh\profiles\desktop\` | 两个 profile 的插件清单与补丁层（工作区外；桌面版 GUI 用 desktop） | 助手维护 |

### prompt/ 内部结构（自动生成，禁止手工编辑）

```
prompt/INDEX.md                  会话索引（主对话置顶，一眼可见）
prompt/对话正文/<时间>-<标题>.md    ★人类消息 + 助手回复正文 + 助手↔子代理往来消息，每条都署名，最常看的就是这个
prompt/会话全文/<时间>-<标题>.md    完整过程（含工具调用、思考、命令输出，长内容有截断提示）
prompt/原始事件/<会话ID>.jsonl      解码后的原始事件流（完全保真）
prompt/.archive-state.json       增量归档状态
```

`prompt/对话正文/` 的署名（分辨「谁说的」就看它，改渲染时必须保留）：

| 署名 | 谁发的 |
| --- | --- |
| `👤 用户（本人）` | **人**在 GUI 里亲手发的 |
| `🤖 助手` | 助手的回复正文 |
| `🧑💻 助手 → 子代理` | **助手**派给子代理的委派任务 / 追加消息（不是人发的） |
| `📨 代理间消息（不是人发的）` | 代理之间中转的消息，如子代理汇报（不是人发的） |

**坑（已修，别踩回去）**：DSH 中**子代理会话**的 `user/message` 其实来自主代理的委派提示，
`source.kind` 同样是 `'user'`。只按 `source.kind` 判断就会把「助手发给子代理的任务」标成
`👤 用户`，读归档的人会以为那句「你是一个前端工程师…」是自己写的。判定必须结合会话身份
（`delegationDepth` / `origin`）与 `source.kind`，逻辑在 `code/tools/dsh-archive.mjs` 的
`messageOrigin()`。

## 3. 铁律：每轮对话都必须归档（必须执行，不允许省略）

`prompt/` 里要保存**完整**的对话过程（**尤其是用户发的消息和助手的回复**），所以每个回合都要把
DSH 会话日志同步一次：

1. **回合开始时**（收到用户消息、开始动手前）执行一次，把上一回合的尾巴补齐：
   ```powershell
   node code/tools/dsh-archive.mjs --quiet
   ```
   并顺手确认常驻归档机制是否活着（它是补上"最后一条回复"的关键）：
   ```powershell
   Get-Content prompt\.archive-watch.log -Tail 3
   ```
   **正常情况下什么都不用做**：`dsh-archive-watch` 宿主插件随 GUI 启动自动运行，
   每轮说完话约 3 秒就会自己归档，日志会不断出现「已归档（触发：event…）」。
   只有当日志超过 1 分钟没有新记录、或文件不存在时（说明插件没生效），
   才用后台任务把老的外部守护脚本当应急方案拉起来：
   ```powershell
   powershell -ExecutionPolicy Bypass -NoProfile -File code\tools\archive-watch.ps1 -IntervalSeconds 10 -MaxHours 12
   ```
   同时要在答复里告诉用户插件没生效（通常是 GUI 还没用新 profile 重启过），别默默降级。
2. **回合结束前**（给出最终答复之前，最后一个工具调用）再执行一次：
   ```powershell
   node code/tools/dsh-archive.mjs --quiet
   ```

### 为什么必须要有常驻机制（重要，别删）

助手的一条回复是在**本轮最后一次工具调用之后**才生成的，因此回合内运行的归档**永远抓不到最后那条回复**；
两个回合之间若没有任何东西在运行，用户就会看到"最后一句话之后的内容没归档"。

现在这一环由**宿主插件**承担：`dsh-archive-watch`
（源码 `C:\Users\sfy\.dsh\plugins\dsh-archive-watch`，作为 bundle 装在 web 与 desktop 两个 profile
的 `dsh.profile.bundles` 里）。它监听宿主的 `session/event`，事件静默 3 秒即归档，
另有 60 秒兜底轮询；**随 GUI 启动自动生效，不需要每次重启 GUI 手动启动脚本**。

`code/tools/archive-watch.ps1` 是同一件事的"外部常驻进程"版本，现在只作为应急后备：
插件失效时手动拉起来用（插件与它都归档同一批会话，不会互相破坏，但会做重复功）。

规则与边界：

- 这是**强制步骤**，不是"可选优化"。即使会话里只是聊天、没有改代码，也要执行。
- 归档数据源是 DSH 落盘的会话日志（`$DSH_HOME/sessions/<项目>/<会话>/session.v<N>.jsonl.zstd`，
  **取版本号最大的那个**，当前是 v4），**不要**用手写总结代替它；也不要把对话内容手工粘贴进 `prompt/`。
- 该脚本零依赖、幂等、永远退出码 0：重复执行只重写有变化的会话。静默运行即可，不要把它
  的输出贴给用户（除非用户明确问起归档情况）。
- 若脚本报错，用 `node code/tools/dsh-archive.mjs`（去掉 `--quiet`）复盘并把错误写进答复。
- 用户问"归档好了吗"时，用 `node code/tools/dsh-archive.mjs --list` 和 `prompt/INDEX.md` 回答。
- **归档必须包含「用户消息」与「助手回复」**：这两类内容在 `prompt/对话正文/` 里必须逐条可见。
  归档后如果发现用户消息缺失或为空，说明 DSH 事件结构变化了（例如 `user/message` 的内容位置），
  先去 `code/tools/dsh-archive.mjs` 修解析，再 `--force` 重新生成；不要用"少几条无所谓"糊弄过去。
- 归档有两类会话：**主对话**（你和用户的对话）与**子代理会话**（你派生的子任务）。
  文件名里带「子代理-」前缀的是后者；主对话永远是索引里第一张表。
- **绝对不要**把 `prompt/` 加进 `.gitignore`，也不要删除或"清理"里面的内容。
- hook 自动化（见 `.dsh/`）是**可选的双保险**：用 `dsh web --patch .dsh/profile-patch.yml` 启动时，
  UserPromptSubmit / Stop 会各调用一次归档脚本。写法上必须注意：`- name: xxx` 这种**没有 id、
  也不是 `insert` 的补丁行会被 loader 整个拒收**（报 `patch: id is required for non-insert patches`），
  正确写法是 `- insert:` 列表并给行一个 id（本工作区历史上就踩过这个坑，导致 hook 从未生效）。
- 用户中断/取消某轮时也要尽量补齐：下一回合开始的第 1 步就是补归档。

## 4. 平台开发约定

- 语言：与用户交流、界面文案、注释、文档统一用**简体中文**。
- 技术栈：以"能立刻跑起来"为第一原则，优先 Node.js 内置能力，新增依赖必须写进 `code/` 下的清单
  并在 `readme.md` 里说明安装步骤。
- 平台必须能**自证可用**：`code/` 里要带示例被测对象（如示例 Web 服务）与示例用例，
  让任何人克隆后一条命令即可跑通全流程。
- 每次交付前自测通过，并把关键结论（运行命令、结果、截图/录像路径）写进 `readme.md`。
- 需要用户决策的（技术栈大改、装大依赖、动全局配置）先问，不要擅自替用户决定。

## 5. 录像约定（video/）

- 只有**真实跑通**的测试过程才录，命名：`video/YYYYMMDD-<被测对象>-<场景>.mp4`。
- 每个录像配一个同名 `.md`，写明：被测软件、测试范围、运行命令、结论、时长。
- 录屏方案在 `readme.md` 里说明；若本机缺少录屏工具，先与用户确认方案再动手。

## 6. 环境事实（本机）

- 工作区：`E:\testPlatform`（Windows，PowerShell 5.1，非 pwsh 7）。
- 已装：Node.js v24.16.0、npm 11.13.0、Python 3.9.13、Git 2.54、DSH（`DSH_HOME=C:\Users\sfy\.dsh`）。
- **沙箱限制**：不要把命令输出管道给 `Select-Object`/`Out-String` 等（会触发命名管道拒绝）；
  直接把输出写文件再读，或让输出原样打印。写工作区外的文件需要用户批准。
- **自动归档插件**：`C:\Users\sfy\.dsh\plugins\dsh-archive-watch`（零依赖，仅用 Node 内置模块），
  已作为 bundle 装进 web 与 desktop **两个** profile 的 `dsh.profile.bundles`。
  **桌面版 GUI 跑的是 `desktop` profile**（`C:\Users\sfy\.dsh\profiles\desktop`），
  `dsh web` 命令行版跑的是 `web`；两个都装，切哪个都不会丢归档。
  重新安装：`dsh plugin --profile desktop add C:\Users\sfy\.dsh\plugins\dsh-archive-watch`
  （web 同理；改完都要重启 GUI 才生效）；卸载把 `add` 换成 `remove`。
- **DSH 升级会改会话日志格式版本**（2026-11 从 `session.v3.jsonl.zstd` 升到 `v4`，
  旧 v3 原地冻结、v4 才是全量超集）。`code/tools/dsh-archive.mjs` 的 `pickSessionLog()`
  取目录里**版本号最大**的日志文件，不写死版本；升级后先跑
  `node code/tools/dsh-archive.mjs --list` 确认还认得到会话，再看 `--quiet` 是否真的产出更新。
  写死版本号的后果很隐蔽：脚本照常"成功"，但归档的是过期日志，新对话一条都不进去。
- 会话归档依赖 Node 24 的 `node:zlib` zstd 支持，不要降级 Node 版本。
- 沙箱内**不能**用管道 stdio 起子进程（`spawn EPERM`）；这只会影响被沙箱包住的命令，
  宿主进程本身可以正常用管道起子进程（`dsh-subprocess-local` 就是这么做的）。
