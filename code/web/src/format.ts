/**
 * 通用格式化 / 小工具：中文文案、时间、耗时、状态色。
 */

/** 耗时：<1000ms 显示 "xx ms"，否则 "x.xx s"。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

/** 时间：统一用 zh-CN 本地化格式。 */
export function formatTime(value: number | null | undefined): string {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN')
}

/** 只要时分秒（日志行用）。 */
export function formatClock(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

export type StatusTone = 'passed' | 'failed' | 'error' | 'skipped' | 'running' | 'cancelled' | 'unknown'

/** 后端状态字符串 -> 展示语义。 */
export function statusTone(status: string | undefined | null): StatusTone {
  switch (status) {
    case 'passed':
      return 'passed'
    case 'failed':
      return 'failed'
    case 'error':
      return 'error'
    case 'skipped':
      return 'skipped'
    case 'running':
      return 'running'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

/** 状态中文名。 */
export function statusLabel(status: string | undefined | null): string {
  switch (status) {
    case 'passed':
      return '通过'
    case 'failed':
      return '失败'
    case 'error':
      return '异常'
    case 'skipped':
      return '跳过'
    case 'running':
      return '执行中'
    case 'cancelled':
      return '已取消'
    case 'pending':
      return '待执行'
    default:
      return status ? String(status) : '未知'
  }
}

/** 用例类型中文名。 */
export function caseTypeLabel(type: string | undefined | null): string {
  if (type === 'api') return 'API'
  if (type === 'web') return 'Web'
  return String(type ?? '')
}

/** 标签输入框（逗号 / 空格分隔）-> 数组。 */
export function parseTags(text: string): string[] {
  return text
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export const tagsToText = (tags: string[] | undefined) => (tags ?? []).join(', ')

/** 生成前端本地 id（步骤 / 断言用；后端也会补，但前端需要稳定 key）。 */
export function localId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${Date.now().toString(36)}${rand}`
}

/** 截断长文本。 */
export function truncate(text: string, max = 300): string {
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max)}…` : text
}
