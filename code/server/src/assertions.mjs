/**
 * 断言引擎：把「断言定义 + 实际上下文」判定为通过/失败，并给出中文可读的说明。
 *
 * 上下文（ctx）由执行器准备：
 *   api: { status, responseTimeMs, headers, bodyText, json }
 *   web: { url, element: { visible, text, count, value } }
 */
import { getByPath, stringifyValue } from './vars.mjs'

export const ASSERTION_TYPES = {
  status: { label: '响应状态码', scope: 'api', needsPath: false },
  jsonPath: { label: 'JSON 取值', scope: 'api', needsPath: true },
  bodyContains: { label: '响应体包含', scope: 'api', needsPath: false },
  bodyMatches: { label: '响应体正则匹配', scope: 'api', needsPath: false },
  headerContains: { label: '响应头包含', scope: 'api', needsPath: true },
  responseTime: { label: '响应耗时(ms)', scope: 'api', needsPath: false },
  urlContains: { label: '当前地址包含', scope: 'web', needsPath: false },
  elementVisible: { label: '元素可见', scope: 'web', needsPath: false },
  elementText: { label: '元素文本', scope: 'web', needsPath: false },
  elementCount: { label: '元素数量', scope: 'web', needsPath: false },
}

export const ASSERTION_OPS = {
  equals: '等于',
  notEquals: '不等于',
  contains: '包含',
  notContains: '不包含',
  matches: '匹配正则',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  exists: '存在',
  truthy: '为真',
}

const asNumber = (value) => {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value)
  return null
}

/** 核心比较：返回 { ok, message }。 */
export function compare(op, actual, expected) {
  const actualText = stringifyValue(actual)

  switch (op) {
    case 'exists':
      return { ok: actual !== undefined && actual !== null, message: `期望值存在，实际 ${actual === undefined ? '缺失' : actualText}` }
    case 'truthy':
      return { ok: Boolean(actual), message: `期望为真，实际 ${actualText || '(空)'}` }
    case 'equals':
    case 'notEquals': {
      const na = asNumber(actual)
      const ne = asNumber(expected)
      const same = na !== null && ne !== null ? na === ne : actualText.trim() === stringifyValue(expected).trim()
      return {
        ok: op === 'equals' ? same : !same,
        message: `期望${ASSERTION_OPS[op]} ${stringifyValue(expected)}，实际 ${actualText}`,
      }
    }
    case 'contains':
    case 'notContains': {
      const hit = actualText.includes(stringifyValue(expected))
      return {
        ok: op === 'contains' ? hit : !hit,
        message: `期望${ASSERTION_OPS[op]} ${stringifyValue(expected)}，实际 ${actualText.slice(0, 300)}`,
      }
    }
    case 'matches': {
      let ok = false
      let note = ''
      try {
        ok = new RegExp(stringifyValue(expected)).test(actualText)
      } catch (error) {
        note = `（正则无效：${error.message}）`
      }
      return { ok, message: `期望匹配正则 /${stringifyValue(expected)}/，实际 ${actualText.slice(0, 300)}${note}` }
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const na = asNumber(actual)
      const ne = asNumber(expected)
      if (na === null || ne === null) {
        return { ok: false, message: `期望数值比较（${ASSERTION_OPS[op]} ${stringifyValue(expected)}），实际值不是数字：${actualText}` }
      }
      const ok = op === 'gt' ? na > ne : op === 'gte' ? na >= ne : op === 'lt' ? na < ne : na <= ne
      return { ok, message: `期望${ASSERTION_OPS[op]} ${ne}，实际 ${na}` }
    }
    default:
      return { ok: false, message: `未知比较符：${op}` }
  }
}

/** 从执行上下文里取出该断言要比较的“实际值”。 */
function resolveActual(assertion, ctx) {
  const { type, path } = assertion
  switch (type) {
    case 'status':
      return ctx.status
    case 'responseTime':
      return ctx.responseTimeMs
    case 'jsonPath':
      return getByPath(ctx.json, path)
    case 'bodyContains':
    case 'bodyMatches':
      return ctx.bodyText ?? ''
    case 'headerContains': {
      const key = String(path ?? '').toLowerCase()
      const headers = ctx.headers ?? {}
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === key) return v
      }
      return undefined
    }
    case 'urlContains':
      return ctx.url ?? ''
    case 'elementVisible':
      return ctx.element?.visible
    case 'elementText':
      return ctx.element?.text
    case 'elementCount':
      return ctx.element?.count
    default:
      return undefined
  }
}

const OP_DEFAULT = {
  elementVisible: 'truthy',
  urlContains: 'contains',
  bodyContains: 'contains',
  bodyMatches: 'matches',
  headerContains: 'contains',
  jsonPath: 'equals',
  status: 'equals',
  responseTime: 'lte',
  elementText: 'contains',
  elementCount: 'gte',
}

/** 判定单条断言。 */
export function evaluateAssertion(assertion, ctx) {
  const op = assertion.op || OP_DEFAULT[assertion.type] || 'equals'
  const actual = resolveActual(assertion, ctx)
  const { ok, message } = compare(op, actual, assertion.expected)
  const meta = ASSERTION_TYPES[assertion.type]
  const label = assertion.name || (meta ? `${meta.label}${assertion.path ? ` ${assertion.path}` : ''}` : assertion.type)
  return {
    assertionId: assertion.id,
    type: assertion.type,
    op,
    label,
    expected: assertion.expected ?? '',
    actual: stringifyValue(actual).slice(0, 2000),
    ok,
    message,
  }
}

/** 批量判定，返回结果数组与是否全部通过。 */
export function evaluateAssertions(assertions = [], ctx) {
  const results = (assertions ?? []).filter(Boolean).map((a) => evaluateAssertion(a, ctx))
  return { results, ok: results.every((r) => r.ok) }
}
