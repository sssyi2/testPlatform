#!/usr/bin/env node
/**
 * dsh-archive.mjs — 把 DSH 会话日志（.dsh/sessions/.../session.v3.jsonl.zstd）
 * 解码并归档成本工作区的可读对话记录。
 *
 * 设计要点
 * - 零依赖：只用 Node 内置模块（node:zlib 的 zstd 支持，Node >= 23.8）。
 * - 数据源是 DSH 自己在磁盘上的会话日志（真相来源），不是模型凭记忆写的总结，
 *   因此归档总是完整、可复核的。
 * - 幂等：同一会话重复运行只重写变化过的文件；文件未增长时直接跳过。
 * - 安全：任何错误都只写 stderr 并返回 0，绝不阻塞 DSH 的 hook（Stop hook 非 0
 *   退出会被解释为“阻断停止”）。
 *
 * 输出
 *   prompt/对话正文/<时间>-<标题>.md   ★人类消息 + 助手回复正文 + 助手↔子代理往来消息，每条都署名
 *                                     （👤 用户（本人） / 🤖 助手 / 🧑💻 助手→子代理 / 📨 代理间消息）
 *   prompt/会话全文/<时间>-<标题>.md   完整过程（工具调用、思考、命令输出）
 *   prompt/原始事件/<会话ID>.jsonl     解码后的原始事件流（完全保真）
 *   prompt/INDEX.md                    会话索引（主对话置顶）
 *   prompt/.archive-state.json         增量状态
 *
 * 署名为什么重要
 *   DSH 里「子代理会话」的 user 消息，其实是主代理（助手）发过去的委派提示，
 *   source.kind 同样是 'user'。不区分会话身份就会把代理间通信标成「用户消息」，
 *   读归档的人会以为那句话是自己发的。判定逻辑见 messageOrigin()。
 *
 * 用法
 *   node code/tools/dsh-archive.mjs                 # 归档本工作区的全部会话
 *   node code/tools/dsh-archive.mjs --list          # 列出发现的会话
 *   node code/tools/dsh-archive.mjs --session <id>  # 只归档一个会话
 *   node code/tools/dsh-archive.mjs --stdin         # 从 stdin 读取 hook 载荷(JSON)
 *   node code/tools/dsh-archive.mjs --force         # 忽略增量状态
 *   node code/tools/dsh-archive.mjs --quiet         # 静默（供 hook 使用）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs'
import { zstdDecompressSync, constants } from 'node:zlib'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

// ---------------------------------------------------------------- 参数解析

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WORKSPACE = resolve(SCRIPT_DIR, '..', '..')

const args = process.argv.slice(2)
const hasFlag = (name) => args.includes(name)
function optionValue(name, fallback) {
  const i = args.indexOf(name)
  if (i >= 0 && i + 1 < args.length) return args[i + 1]
  return fallback
}

const QUIET = hasFlag('--quiet') || hasFlag('-q')
const FORCE = hasFlag('--force')
const LIST_ONLY = hasFlag('--list')
const FROM_STDIN = hasFlag('--stdin')
const SESSION_FILTER = optionValue('--session', null)
const WORKSPACE = resolve(optionValue('--workspace', process.env.CLAUDE_PROJECT_DIR ?? DEFAULT_WORKSPACE))
const MAX_TOOL_CHARS = Number(optionValue('--max-tool-chars', '6000'))
const MAX_ARGS_CHARS = Number(optionValue('--max-args-chars', '4000'))
const MAX_DELEGATION_CHARS = Number(optionValue('--max-delegation-chars', '12000'))
/** 代理间消息（非人类）正文超过这个长度就折叠；人类消息从不折叠。 */
const AGENT_BODY_INLINE_CHARS = Number(optionValue('--agent-body-inline-chars', '2000'))

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const PROMPT_DIR = join(WORKSPACE, 'prompt')
const CHAT_OUT = join(PROMPT_DIR, '对话正文')     // 只有「用户消息」与「助手回复正文」
const FULL_OUT = join(PROMPT_DIR, '会话全文')     // 完整过程（含工具调用、思考、系统注入）
const RAW_OUT = join(PROMPT_DIR, '原始事件')      // 解码后的原始事件流（完全保真）
const LEGACY_DIRS = [join(PROMPT_DIR, 'sessions'), join(PROMPT_DIR, 'raw')]
const STATE_FILE = join(PROMPT_DIR, '.archive-state.json')

const log = (...a) => { if (!QUIET) console.log(...a) }
const warn = (...a) => console.error(...a)

// ------------------------------------------------------- zstd 多帧解码

const ZSTD_MAGIC = 4247762216

/**
 * 定位拼接式 zstd 日志里的完整帧边界（移植自 dsh-session-persistence-jsonl）。
 * 日志每批事件追加一个独立帧；正在写入的最后一帧可能被截断。
 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** 解出会话日志里全部事件的原始文本行（损坏/截断部分容忍跳过）。 */
function readSessionEvents(file) {
  const buffer = readFileSync(file)
  let frames = []
  let tornStart
  try {
    ({ frames, tornStart } = scanZstdFrames(buffer))
  } catch (error) {
    warn(`[archive] ${basename(dirname(file))}: ${error.message}`)
    return { events: [], badLines: 0, bytes: buffer.length }
  }

  let text = ''
  for (const { start, end } of frames) {
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch (error) {
      warn(`[archive] frame decode failed at ${start}: ${error.message}`)
    }
  }
  // 正在写入的最后一帧：尽力抢救出已落盘的部分明文
  if (tornStart !== undefined) {
    try {
      text += zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush }).toString('utf8')
    } catch { /* 未完成帧忽略，下一次归档会补上 */ }
  }

  const events = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      badLines++
    }
  }
  return { events, badLines, bytes: buffer.length }
}

/** 只读第一帧，取会话头（cwd / 创建时间）。 */
function readSessionHeader(file) {
  const buffer = readFileSync(file)
  const { frames } = scanZstdFrames(buffer, 1)
  if (!frames.length) return null
  const text = zstdDecompressSync(buffer.subarray(frames[0].start, frames[0].end)).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'session') return event
    } catch { /* 继续 */ }
  }
  return null
}

// ------------------------------------------------------------- 文本工具

const localTime = (ms) => {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 文件名安全化：去掉 Windows 不允许的字符与空白，并限长。 */
function safeName(text, limit = 40) {
  return String(text ?? '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/[\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, limit)
    .replace(/^[-.]+|[-.]+$/g, '')
}

/** 生成人类可读的文件名：2026-09-21_1856-标题-短ID.md */
function sessionFileName({ id, title, createdAt, isSub }) {
  const date = Number.isFinite(createdAt) ? localTime(createdAt).slice(0, 16).replace(' ', '_').replace(':', '') : 'unknown'
  const shortId = String(id).replace(/^session-/, '').slice(0, 8)
  const name = safeName(title)
  return `${date}-${isSub ? '子代理-' : ''}${name}${name ? '-' : ''}${shortId}.md`
}

function truncate(text, limit, label = 'truncated') {
  if (typeof text !== 'string') text = String(text ?? '')
  if (text.length <= limit) return text
  const removed = text.length - limit
  return `${text.slice(0, limit)}\n\n... [${label}: ${removed} chars omitted, 完整内容见 prompt/原始事件/*.jsonl] ...\n`
}

/** 选择不会与内容冲突的代码围栏。 */
function fence(text, lang = '') {
  let ticks = '```'
  while (text.includes(ticks)) ticks += '`'
  return `${ticks}${lang}\n${text}\n${ticks}`
}

function blockText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  const parts = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'tool-result') parts.push(blockText(part.content))
    else if (part.type === 'reasoning' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n\n')
}

/** 归一化“来源”，用于区分人类输入与系统注入的上下文。 */
function sourceKind(message) {
  const source = message?.source
  if (!source || typeof source !== 'object') return 'unknown'
  return source.kind ?? 'unknown'
}

/** 会话是不是「被主代理委派出来的子代理会话」。 */
function isSubagentSession(header) {
  return (header?.delegationDepth ?? 0) > 0 || header?.origin === 'subagent'
}

/** session-xxxx / 裸 id 统一成短 id。 */
function shortSessionId(id) {
  const text = String(id ?? '').replace(/^session-/, '')
  return text ? text.slice(0, 8) : '未知'
}

/**
 * 判断一条 `user/message` 到底是谁发的。
 *
 * 这里有个必须绕开的坑：**子代理会话里，主代理（助手）的委派提示 source.kind 也是 'user'**。
 * 只看 source.kind 就打成「用户消息」的话，人机对话和代理间通信会混在一起 ——
 * 读归档的人会以为「你是一个前端工程师…」那句是自己发的。所以：
 *   1) 先看会话身份：子代理会话里的 user 消息必然是主代理派活，不是人类；
 *   2) 再看 source.kind：agent-message 是代理之间中转的消息。
 * 返回 { role, kind, label }，role ∈ human | parent | agent | system。
 */
function messageOrigin(message, header, roster) {
  const kind = sourceKind(message)
  if (kind === 'user') {
    if (isSubagentSession(header)) {
      const from = header?.parentSession ? `（来自会话 \`${header.parentSession}\`）` : ''
      return { role: 'parent', kind, label: `🧑💻 主代理（助手）→ 本子代理 · 委派任务${from}` }
    }
    return { role: 'human', kind, label: '👤 用户（本人）' }
  }
  if (kind === 'agent-message') return { role: 'agent', kind, label: agentRelayLabel(message, roster) }
  return { role: 'system', kind, label: `📎 系统注入上下文（source: ${kind}）` }
}

/** 代理间中转消息的署名：说清「谁发给本会话」，并显式写明不是人发的。 */
function agentRelayLabel(message, roster) {
  const sender = message?.source?.senderSessionId
  const known = sender ? roster?.get(sender) : undefined
  let who
  if (known) who = `${isSubagentSession(known) ? '子代理' : '主代理（助手）'} \`${shortSessionId(sender)}\``
  else if (sender) who = `代理会话 \`${shortSessionId(sender)}\``
  else who = '未知代理会话'
  return `📨 代理间消息（不是人发的）：${who} → 本会话`
}

/** 去掉代理中继消息自带的「Agent xxx sent a message: 」样板前缀。 */
function stripRelayPrefix(text) {
  return String(text ?? '').replace(/^Agent\s+\S+\s+sent a message:\s*/i, '').trim()
}

/**
 * 助手用来跟子代理说话的工具：这些调用的正文也要在「对话正文」里署名出现，
 * 否则「哪些是助手对子代理发的消息」就只能在会话全文的 JSON 里翻。
 */
const DELEGATION_TOOLS = new Map([
  ['subagent', '委派任务（子代理）'],
  ['subagent_fork', '委派任务（fork 子代理）'],
  ['send_message', '追加消息'],
  ['interrupt_agent', '打断子代理'],
])

/** 工具参数可能是 JSON 字符串也可能是对象，统一成对象。 */
function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 非人类消息（代理间往来）正文过长时折叠；人类消息从不折叠。 */
function renderAgentBody(text, origin) {
  if (origin.role === 'human' || text.length <= AGENT_BODY_INLINE_CHARS) return text
  return [
    `<details><summary>展开消息正文（${text.length} 字，来自「${origin.role === 'parent' ? '主代理' : '代理'}」，不是人发的）</summary>`,
    '',
    fence(text),
    '',
    '</details>',
  ].join('\n')
}

/** 助手与子代理之间的一条消息，渲染成带署名的块（方向按收件人身份判定）。 */
function renderDelegation(part, roster) {
  const args = parseToolArgs(part.arguments)
  const body = typeof args.prompt === 'string' ? args.prompt : (typeof args.message === 'string' ? args.message : '')
  const targetId = typeof args.agent_id === 'string' ? args.agent_id : ''
  const targetHeader = targetId ? roster?.get(targetId) : undefined
  // 收件人不是子代理会话 → 这条是「子代理回主代理」，不是「助手派活」。
  // 子代理会话里助手就是那个子代理，它调 send_message 是去汇报，不能标成「→ 子代理」。
  const toParent = Boolean(targetHeader) && !isSubagentSession(targetHeader)
  const target = typeof args.description === 'string' && args.description.trim()
    ? args.description.trim()
    : (targetId ? `会话 \`${shortSessionId(targetId)}\`` : '')
  const out = []
  out.push(toParent
    ? `### 📨 子代理（本会话）→ 主代理（助手）· ${DELEGATION_TOOLS.get(part.name)}`
    : `### 🧑💻 助手 → 子代理 · ${DELEGATION_TOOLS.get(part.name)}`)
  out.push('')
  out.push(`- 工具：\`${part.name}\`${target ? `　·　对象：${target}` : ''}`)
  if (body.trim()) {
    out.push('')
    out.push(`<details><summary>展开这条代理消息的正文（${body.length} 字，**不是人发的**）</summary>`)
    out.push('')
    out.push(fence(truncate(body.trim(), MAX_DELEGATION_CHARS, 'delegation truncated')))
    out.push('')
    out.push('</details>')
  } else {
    out.push('')
    out.push('（本条调用没有正文）')
  }
  out.push('')
  return out
}

function prettyArgs(raw) {
  if (typeof raw !== 'string') return JSON.stringify(raw ?? {}, null, 2)
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

// ------------------------------------------------------------- 渲染

/** 把事件流渲染成 markdown 对话记录。 */
function renderSession(header, events, meta, roster) {
  const out = []
  const title = meta.title || '(无标题)'

  out.push(`# 会话记录：${title}`)
  out.push('')
  out.push('| 项目 | 值 |')
  out.push('| --- | --- |')
  out.push(`| 会话 ID | \`${header.id}\` |`)
  out.push(`| 工作目录 | \`${header.cwd ?? ''}\` |`)
  out.push(`| 创建时间 | ${localTime(header.createdAt)} |`)
  out.push(`| 归档时间 | ${localTime(Date.now())} |`)
  out.push(`| 模型 | ${meta.model ?? '未知'} |`)
  out.push(`| 轮次 / 事件数 | ${meta.turns} / ${events.length} |`)
  out.push(`| 原始事件流 | \`prompt/原始事件/${header.id}.jsonl\` |`)
  out.push('')
  out.push('> 本文件由 `code/tools/dsh-archive.mjs` 从 DSH 会话日志自动生成，请勿手工编辑。')
  out.push('')

  let turn = 0
  let step = 0
  let pendingToolCalls = new Map()

  for (const event of events) {
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start': {
        turn = data.turn ?? turn + 1
        out.push('---')
        out.push('')
        out.push(`## 第 ${turn} 轮 · ${localTime(event.time)}`)
        out.push('')
        break
      }
      case 'user/message': {
        // 注意：DSH 的 user/message 事件把内容直接放在 data.content / data.source 下
        // （assistant/message 才包在 data.message 里），两种形状都要兼容。
        const message = data.message ?? data
        const origin = messageOrigin(message, header, roster)
        const raw = blockText(message.content)
        const text = origin.role === 'agent' ? stripRelayPrefix(raw) : raw.trim()
        if (!text.trim()) break
        if (origin.role === 'system') {
          // AGENTS.md、system-reminder、插件通知等：不是对话内容，折叠起来备查
          out.push(`<details><summary>${origin.label}</summary>`)
          out.push('')
          out.push(fence(truncate(text.trim(), 4000, 'context truncated')))
          out.push('')
          out.push('</details>')
          out.push('')
          break
        }
        if (origin.role === 'human') turn = data.turn ?? turn
        out.push(`### ${origin.label}`)
        out.push('')
        out.push(renderAgentBody(text.trim(), origin))
        out.push('')
        break
      }
      case 'assistant/message': {
        const message = data.message ?? {}
        step = data.step ?? step
        const usage = data.usage
        for (const part of message.content ?? []) {
          if (part.type === 'reasoning' && part.text?.trim()) {
            out.push(`<details><summary>🧠 思考过程（第 ${turn} 轮 / 第 ${step} 步）</summary>`)
            out.push('')
            out.push(part.text.trim())
            out.push('')
            out.push('</details>')
            out.push('')
          } else if (part.type === 'text' && part.text?.trim()) {
            out.push('### 🤖 助手')
            out.push('')
            out.push(part.text.trim())
            out.push('')
          } else if (part.type === 'tool-call') {
            pendingToolCalls.set(part.id, part.name)
            out.push(`#### 🔧 调用工具 \`${part.name}\``)
            out.push('')
            out.push(fence(truncate(prettyArgs(part.arguments), MAX_ARGS_CHARS, 'args truncated'), 'json'))
            out.push('')
          }
        }
        if (usage && !QUIET) {
          out.push(`<!-- tokens: in=${usage.inputTokens ?? '?'} out=${usage.outputTokens ?? '?'} total=${usage.totalTokens ?? '?'} -->`)
          out.push('')
        }
        break
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const callId = message.source?.callId
        const name = pendingToolCalls.get(callId) ?? 'tool'
        const text = blockText(message.content)
        const failed = Boolean(data.error) || (message.content ?? []).some((c) => c?.isError)
        out.push(`#### ${failed ? '❌' : '✅'} 工具结果 \`${name}\`${failed ? `（失败：${data.error?.name ?? 'error'}）` : ''}`)
        out.push('')
        out.push(fence(truncate(text.trim(), MAX_TOOL_CHARS, 'tool output truncated')))
        out.push('')
        break
      }
      case 'turn/end': {
        const reason = data.reason?.kind ?? 'unknown'
        out.push(`> 第 ${turn} 轮结束（${reason}）`)
        out.push('')
        break
      }
      default:
        break
    }
  }

  return out.join('\n')
}

/**
 * 「对话正文」：人类消息 + 助手回复正文 + 助手与子代理之间的往来消息，每条都署名。
 * 去掉工具调用、思考过程、系统注入，用于快速通读整段对话（这正是用户最关心的部分）。
 *
 * 署名是刚需：子代理会话里的「user 消息」其实是主代理的委派提示，
 * 不署名就无法区分「我发的」和「助手对子代理发的」。
 */
function renderConversation(header, events, meta, roster) {
  const sub = isSubagentSession(header)
  const out = []
  out.push(`# 对话正文：${meta.title || '(无标题)'}`)
  out.push('')
  out.push(`- 会话 ID：\`${header.id}\``)
  out.push(`- 创建时间：${localTime(header.createdAt)}`)
  out.push(`- 会话类型：${sub ? `**子代理会话**（主代理委派，父会话 \`${header.parentSession ?? '未知'}\`；本会话里没有人类消息）` : '**主对话**（你与助手的对话）'}`)
  out.push(`- 归档时间：${localTime(Date.now())}`)
  out.push(`- 轮次：${meta.turns}`)
  out.push('')
  out.push('署名约定：')
  out.push('')
  out.push('| 署名 | 谁发的 |')
  out.push('| --- | --- |')
  if (sub) {
    out.push('| 🧑💻 主代理（助手）→ 本子代理 · 委派任务 | **助手**（不是人） |')
    out.push('| 📨 代理间消息（不是人发的）… | **助手/代理**（不是人） |')
    out.push('| 🤖 助手 | 本子代理（助手）的回复正文 |')
  } else {
    out.push('| 👤 用户（本人） | **你**，在 GUI 里亲手发的 |')
    out.push('| 🤖 助手 | 助手（我）的回复正文 |')
    out.push('| 🧑💻 助手 → 子代理 | **助手**派给子代理的任务/追加消息（不是人发的） |')
    out.push('| 📨 代理间消息（不是人发的）… | 子代理汇报等代理间中转的消息（不是人发的） |')
  }
  out.push('')
  out.push('> 工具调用、思考过程、系统注入上下文见同名的「会话全文」。')
  out.push('> 由 `code/tools/dsh-archive.mjs` 自动生成，请勿手工编辑。')
  out.push('')

  let turn = 0
  let pending = []
  const flush = () => {
    if (!pending.length) return
    out.push('### 🤖 助手')
    out.push('')
    out.push(pending.join('\n\n').trim())
    out.push('')
    pending = []
  }

  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      flush()
      turn = data.turn ?? turn + 1
      out.push('---')
      out.push('')
      out.push(`## 第 ${turn} 轮 · ${localTime(event.time)}`)
      out.push('')
      continue
    }
    if (event.type === 'user/message') {
      const message = data.message ?? data
      const origin = messageOrigin(message, header, roster)
      if (origin.role === 'system') continue
      const raw = blockText(message.content)
      const text = origin.role === 'agent' ? stripRelayPrefix(raw) : raw.trim()
      if (!text.trim()) continue
      flush()
      out.push(`### ${origin.label}`)
      out.push('')
      out.push(renderAgentBody(text.trim(), origin))
      out.push('')
      continue
    }
    if (event.type === 'assistant/message') {
      const message = data.message ?? {}
      for (const part of message.content ?? []) {
        if (part.type === 'text' && part.text?.trim()) {
          pending.push(part.text.trim())
        } else if (part.type === 'tool-call' && DELEGATION_TOOLS.has(part.name)) {
          // 助手对子代理说的话也留痕：否则「你发给子代理的消息」只能去会话全文里翻 JSON
          flush()
          out.push(...renderDelegation(part, roster))
        }
      }
      continue
    }
  }
  flush()
  return out.join('\n')
}

function decodeSession(file) {
  const { events, badLines, bytes } = readSessionEvents(file)
  const header = events.find((e) => e.type === 'session')
  if (!header) return null
  const titleEvent = [...events].reverse().find((e) => e.type === 'session/title')
  const contextEvent = events.find((e) => e.type === 'request/context')
  const turns = new Set()
  for (const e of events) {
    if (e.type === 'turn/start') turns.add(e.data?.turn)
  }
  const firstUser = events.find((e) => e.type === 'user/message' && sourceKind(e.data?.message ?? e.data) === 'user')
  const fallbackTitle = blockText((firstUser?.data?.message ?? firstUser?.data)?.content).split('\n')[0]?.slice(0, 60)
  return {
    header,
    events,
    badLines,
    bytes,
    title: titleEvent?.data?.title ?? fallbackTitle ?? '',
    model: contextEvent ? `${contextEvent.data?.provider}/${contextEvent.data?.model}` : null,
    turns: turns.size,
  }
}

/**
 * 选出一个会话目录里「最新版本」的日志文件。
 *
 * DSH 升级会话格式时会**同时保留旧文件**：例如升级到 v4 后，
 * `session.v3.jsonl.zstd` 原地冻结、`session.v4.jsonl.zstd` 才是全量超集。
 * 所以不能写死版本号 —— 必须取目录里版本号最大的那个，否则会安静地归档过期日志：
 * 表面上"归档成功"，实际新对话一条都没进去（2026-11 的 DSH 升级就踩了这个坑）。
 * `session.jsonl`（无版本号）排最后，作为旧部署的兜底。
 * @param dir 会话目录
 * @returns `{ name, version, compressed }`，挑不到时返回 null
 */
function pickSessionLog(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const candidates = []
  for (const name of entries) {
    const versioned = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name)
    if (versioned) {
      candidates.push({ name, version: Number(versioned[1]), compressed: Boolean(versioned[2]) })
    } else if (name === 'session.jsonl' || name === 'session.jsonl.zstd') {
      candidates.push({ name, version: 0, compressed: name.endsWith('.zstd') })
    }
  }
  if (!candidates.length) return null
  // 版本号大的优先；同版本不会同时存在两种容器，压缩的排前面只是保险。
  candidates.sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed))
  return candidates[0]
}

function listSessionFiles() {
  const found = []
  if (!existsSync(SESSIONS_ROOT)) return found
  for (const projectDir of readdirSync(SESSIONS_ROOT)) {
    const projectPath = join(SESSIONS_ROOT, projectDir)
    let entries = []
    try {
      if (!statSync(projectPath).isDirectory()) continue
      entries = readdirSync(projectPath)
    } catch { continue }
    for (const sessionDir of entries) {
      const dir = join(projectPath, sessionDir)
      const logFile = pickSessionLog(dir)
      if (!logFile) continue
      found.push({
        file: join(dir, logFile.name),
        version: logFile.version,
        sessionDir: dir,
        project: projectDir,
        slug: sessionDir,
        compressed: logFile.compressed,
      })
    }
  }
  return found
}

function workspaceMatches(cwd) {
  if (!cwd) return false
  const normalize = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  return normalize(cwd) === normalize(WORKSPACE)
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { version: 1, sessions: {} }
  }
}

function writeFileAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function main() {
  // hook 载荷（可选）：里面有 session_id / cwd，可为日志提供上下文
  let hookPayload = null
  if (FROM_STDIN) {
    try {
      const raw = readFileSync(0, 'utf8')
      if (raw.trim()) hookPayload = JSON.parse(raw)
    } catch { /* 无载荷也可以正常归档 */ }
  }

  if (!existsSync(PROMPT_DIR)) mkdirSync(PROMPT_DIR, { recursive: true })
  if (FORCE) {
    // --force = 干净重建：先清掉旧的渲染产物，避免改名后留下孤儿文件
    for (const dir of [CHAT_OUT, FULL_OUT]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  }
  for (const dir of [CHAT_OUT, FULL_OUT, RAW_OUT]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  const candidates = listSessionFiles()
  const state = FORCE ? { version: 1, sessions: {} } : loadState()

  // 过滤出属于本工作区的会话
  const mine = []
  for (const candidate of candidates) {
    if (SESSION_FILTER) {
      const wanted = SESSION_FILTER.replace(/^session-/, '')
      if (!candidate.slug.includes(wanted)) continue
    }
    let header = null
    try {
      header = readSessionHeader(candidate.file)
    } catch (error) {
      warn(`[archive] 读取 ${candidate.file} 失败：${error.message}`)
      continue
    }
    if (!header) continue
    if (!workspaceMatches(header.cwd)) continue
    mine.push({ ...candidate, header })
  }

  // 会话名册：代理间消息要知道「发件人是谁」（子代理还是主代理），才能正确署名
  const roster = new Map(mine.map((item) => [item.header.id, item.header]))

  if (LIST_ONLY) {
    log(`工作区：${WORKSPACE}`)
    log(`发现 ${mine.length} 个会话：`)
    for (const item of mine) {
      const size = statSync(item.file).size
      log(`  ${item.header.id}  cwd=${item.header.cwd}  created=${localTime(item.header.createdAt)}  bytes=${size}`)
    }
    if (hookPayload) log(`hook 载荷：session_id=${hookPayload.session_id ?? '?'} event=${hookPayload.hook_event_name ?? '?'}`)
    return
  }

  const index = []
  let archived = 0
  let skipped = 0

  for (const item of mine) {
    const id = item.header.id
    const stat = statSync(item.file)
    const previous = state.sessions[id]
    const isSub = (item.header.delegationDepth ?? 0) > 0
    const fileName = previous?.fileName ?? sessionFileName({ id, title: '', createdAt: item.header.createdAt, isSub })
    const fullFile = join(FULL_OUT, fileName)
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && existsSync(fullFile) && !FORCE) {
      skipped++
      index.push({ id, ...previous, isSub })
      continue
    }

    const decoded = decodeSession(item.file)
    if (!decoded) {
      warn(`[archive] ${id}: 未找到会话头，跳过`)
      continue
    }
    const meta = {
      title: decoded.title,
      model: decoded.model,
      turns: decoded.turns,
    }
    const finalName = previous?.fileName ?? sessionFileName({
      id,
      title: decoded.title,
      createdAt: decoded.header.createdAt,
      isSub,
    })

    // 1) 对话正文：人类消息 + 助手回复正文 + 助手↔子代理的往来消息，每条都署名
    writeFileAtomic(join(CHAT_OUT, finalName), renderConversation(decoded.header, decoded.events, meta, roster))
    // 2) 会话全文：完整过程（工具调用、思考、系统注入都在里面，长内容会截断提示）
    writeFileAtomic(join(FULL_OUT, finalName), renderSession(decoded.header, decoded.events, meta, roster))
    // 3) 原始事件流：完全保真
    writeFileAtomic(
      join(RAW_OUT, `${id}.jsonl`),
      decoded.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    )
    if (decoded.badLines > 0) warn(`[archive] ${id}: 跳过 ${decoded.badLines} 行不完整数据（写入中）`)

    state.sessions[id] = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      title: decoded.title,
      fileName: finalName,
      isSub,
      createdAt: decoded.header.createdAt,
      updatedAt: Date.now(),
      turns: decoded.turns,
      events: decoded.events.length,
      cwd: decoded.header.cwd,
    }
    index.push({ id, ...state.sessions[id] })
    archived++
    log(`[archive] 已归档 ${isSub ? '子代理会话' : '主对话'} ${id}（${decoded.events.length} 个事件，${decoded.turns} 轮）→ prompt/对话正文/${finalName}`)
  }

  // 清理旧版目录结构（sessions/ 与 raw/），避免同一份内容存在两个地方
  for (const dir of LEGACY_DIRS) {
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
        log(`[archive] 已清理旧目录：${dir}`)
      } catch { /* 清理失败不影响归档 */ }
    }
  }

  if (!index.length && !mine.length) {
    log(`[archive] 工作区 ${WORKSPACE} 下没有找到会话日志（${SESSIONS_ROOT}）`)
  } else if (archived === 0) {
    log(`[archive] 全部最新，无需更新（跳过 ${skipped} 个）`)
  } else {
    log(`[archive] 本次更新 ${archived} 个会话，跳过 ${skipped} 个`)
  }

  // 汇总索引（用完整状态，保证历史会话不丢）
  const all = Object.entries(state.sessions)
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const main = all.filter((info) => !info.isSub)
  const subs = all.filter((info) => info.isSub)

  const row = (info) => {
    const title = String(info.title ?? '').replace(/\|/g, '\\|').slice(0, 60)
    const name = info.fileName ?? `${info.id}.md`
    const chat = encodeURI(`对话正文/${name}`)
    const full = encodeURI(`会话全文/${name}`)
    return `| ${localTime(info.createdAt)} | **${title || '(无标题)'}** | ${info.turns ?? '?'} | ${info.events ?? '?'} | [📄 对话正文](${chat}) · [🔍 会话全文](${full}) · [🧾 原始事件](原始事件/${info.id}.jsonl) |`
  }

  const lines = [
    '# 对话归档索引',
    '',
    `- 工作区：\`${WORKSPACE}\``,
    `- 主对话：${main.length} 段　·　子代理会话：${subs.length} 段`,
    `- 最近更新：${localTime(Date.now())}`,
    '',
    '## 怎么找我要的内容',
    '',
    '| 想看什么 | 去哪个目录 |',
    '| --- | --- |',
    '| **我发给你的消息 + 你的回复** | `prompt/对话正文/` ← 干净版；每条都署名：👤 用户（本人）/ 🤖 助手 / 🧑💻 助手→子代理 / 📨 代理间消息 |',
    '| 完整过程（含工具调用、思考、命令输出） | `prompt/会话全文/` |',
    '| 完全保真的原始事件流（JSON，每行一个事件） | `prompt/原始事件/` |',
    '',
    '重新生成：`node code/tools/dsh-archive.mjs --force`。',
    '',
    '## 主对话（你与本助手的对话）',
    '',
    '| 创建时间 | 标题 | 轮次 | 事件数 | 记录 |',
    '| --- | --- | --- | --- | --- |',
    ...main.map(row),
    '',
  ]
  if (subs.length) {
    lines.push('## 子代理会话（主对话中派生出的子任务，属于同一项目的完整过程）')
    lines.push('')
    lines.push('| 创建时间 | 标题 | 轮次 | 事件数 | 记录 |')
    lines.push('| --- | --- | --- | --- | --- |')
    lines.push(...subs.map(row))
    lines.push('')
  }
  writeFileAtomic(join(PROMPT_DIR, 'INDEX.md'), lines.join('\n'))
  writeFileAtomic(STATE_FILE, JSON.stringify(state, null, 2))
}

try {
  main()
} catch (error) {
  // 绝不让归档失败影响 DSH 会话（Stop hook 的非 0 退出会被当作“继续对话”）
  warn(`[archive] 归档失败：${error?.stack ?? error}`)
}
process.exit(0)
