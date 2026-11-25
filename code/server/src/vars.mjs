/**
 * 变量插值与取值工具。
 *
 * 支持：
 *   {{baseUrl}}、{{token}} 等自定义变量（项目级 / 用例级 / 本次执行覆盖）
 *   {{$timestamp}} {{$isoDate}} {{$uuid}} {{$randomInt}} 内置动态变量
 *   $.data.items[0].name / data.items[0].name 形式的取值
 */
import { randomUUID } from 'node:crypto'

export function builtinVars(now = Date.now()) {
  return {
    '$timestamp': String(now),
    '$isoDate': new Date(now).toISOString(),
    '$date': new Date(now).toISOString().slice(0, 10),
    '$uuid': randomUUID(),
    '$randomInt': String(Math.floor(Math.random() * 100000)),
  }
}

/** 把模板里的 {{name}} 替换成变量值；未定义的变量保持原样并计入 missing。 */
export function interpolate(template, vars, missing = new Set()) {
  if (template == null) return template
  if (typeof template !== 'string') return template
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      const value = vars[name]
      return value == null ? '' : String(value)
    }
    missing.add(name)
    return whole
  })
}

/** 递归插值：字符串、数组、对象都会处理。 */
export function interpolateDeep(value, vars, missing = new Set()) {
  if (typeof value === 'string') return interpolate(value, vars, missing)
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, vars, missing))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, vars, missing)
    return out
  }
  return value
}

/** 取值：支持 $.a.b[0].c 与 a.b[0].c；也接受 JSON 里带点的键（优先整键匹配）。 */
export function getByPath(root, path) {
  if (root == null) return undefined
  if (path == null || path === '' || path === '$') return root
  const normalized = String(path).trim().replace(/^\$\.?/, '')
  if (!normalized) return root

  const segments = []
  const re = /([^.[\]]+)|\[(\d+)\]/g
  let match
  while ((match = re.exec(normalized)) !== null) {
    if (match[2] !== undefined) segments.push(Number(match[2]))
    else segments.push(match[1])
  }

  let cursor = root
  for (const segment of segments) {
    if (cursor == null) return undefined
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor)) return undefined
      cursor = cursor[segment]
    } else if (typeof cursor === 'object' && Object.prototype.hasOwnProperty.call(cursor, segment)) {
      cursor = cursor[segment]
    } else {
      return undefined
    }
  }
  return cursor
}

/** 把任意值渲染成便于断言/展示的字符串。 */
export function stringifyValue(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 从文本中按正则抽取（无正则时返回原文）。 */
export function extractByRegex(text, pattern, group = 1) {
  if (!pattern) return text
  const re = new RegExp(pattern)
  const match = re.exec(text ?? '')
  if (!match) return undefined
  return match[group] ?? match[0]
}
