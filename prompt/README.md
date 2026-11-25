# prompt/ — 对话过程归档

这个文件夹保存**在本工作区（`E:\testPlatform`）里发生的完整人机对话**，用于复盘"这个测试平台
是怎么一步步被做出来的、调试过程是怎样的"。

内容是**自动生成**的，不要手工编辑（下一次归档会覆盖）。

## 一、先看这里（按需求选目录）

| 你想看什么 | 去哪里 | 大小量级 |
| --- | --- | --- |
| **我发给你的消息 + 你的回复** | `对话正文/` ← 干净版，只有这两样 | 20 KB 左右 |
| 完整过程（工具调用、思考过程、每条命令输出） | `会话全文/` | 数百 KB |
| 完全保真的原始事件流（JSON，每行一个事件） | `原始事件/` | 数 MB |
| 常驻归档守护进程是否还活着 | `.archive-watch.log` 的最后一行时间戳 | 很小 |

文件名格式：`<创建时间>-<标题>-<短ID>.md`；带 `子代理-` 前缀的是主对话里派生出的子任务会话
（例如"前端工程师""后端工程师"），它们属于同一项目的完整过程，但不是你和我的直接对话。

`INDEX.md` 是索引：**主对话（你和我的对话）永远在第一张表**。

## 二、数据来源

DSH 自己会把每个会话落盘为
`C:\Users\sfy\.dsh\sessions\<工作区目录名>\<会话ID>\session.v3.jsonl.zstd`
（拼接式 zstd 帧，每批事件一个帧）。

`code/tools/dsh-archive.mjs` 负责：拼接帧边界扫描 → 逐帧解压 → 解析 v3 事件 → 渲染两种 markdown
（`对话正文` 只取 `user/message` 与 `assistant/message` 的正文；`会话全文` 还包含思考、工具调用与结果）。

> ⚠️ 事件形状有个坑：`user/message` 的内容在 `data.content`，而 `assistant/message` 在 `data.message`。
> 只按后者的形状解析会把**用户消息整段丢掉**（本仓库曾经踩过这个坑，已修复并写进 AGENTS.md 铁律）。

## 三、什么时候归档（四层保障）

1. **常驻守护进程（自动，唯一能补上"最后一条回复"的机制）**：
   `code/tools/archive-watch.ps1` 每 10 秒检查一次会话日志，一变就归档，运行情况记在
   `prompt/.archive-watch.log`。启动方式：
   ```powershell
   powershell -ExecutionPolicy Bypass -File code\tools\archive-watch.ps1
   ```
   它默认跑 12 小时（`-MaxHours` 可调）后自动退出；GUI 重启会带走它，届时重新启动即可。
2. **DSH hook（自动，重启 GUI 后生效）**：`.dsh/hooks.json` 配了 `Stop`（每轮结束）与
   `UserPromptSubmit`（收到新消息）两个 hook；全局 profile 补丁已写入
   `C:\Users\sfy\.dsh\profiles\web\cordis.patch.yml`（**进程启动时读一次**）。
   启用后效果等同守护进程，那时守护进程只是冗余保险。
3. **AGENTS.md 铁律（自动，兜底）**：助手在每个回合的**开始**和**结束**各跑一次归档；
   回合开始那次会把上一回合的尾巴补上。缺点是"最后一条回复"仍要等到下一回合。
4. **手动（随时）**：
   ```powershell
   node code/tools/dsh-archive.mjs            # 增量归档本工作区全部会话
   node code/tools/dsh-archive.mjs --force    # 全量重写（改了渲染逻辑后用这个）
   node code/tools/dsh-archive.mjs --list     # 只列出发现了哪些会话
   ```

## 四、为什么会"看起来缺了一段"（重要）

助手的一条回复是**在本轮最后一次工具调用之后**才生成并落盘的，所以：

- 回合内运行的归档（包括助手的收尾归档）**永远看不到最后那条回复**；
- 如果两个回合之间没有任何东西在跑归档，用户就会看到"最后一句话之后的内容没归档"。

真正解决这个问题的只有两种机制：**常驻守护进程**（第 1 条，不需要重启）或 **DSH Stop hook**
（第 2 条，重启 GUI 后生效）。只靠 AGENTS.md 铁律时，缺的那段会**晚一个回合**补齐。

排查方法：

```powershell
# 守护进程还活着吗？（最后一行应该是一分钟内的）
Get-Content prompt\.archive-watch.log -Tail 3

# 归档快照里有没有我最后说的话？
Select-String -Path prompt\对话正文\*.md -Pattern '关键词'
```
