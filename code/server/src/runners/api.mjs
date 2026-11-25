/**
 * API 用例执行器：按步骤发 HTTP 请求、抽取变量、判定断言。
 * 只用 Node 内置 fetch（Node 18+），无第三方依赖。
 */
import { evaluateAssertions } from '../assertions.mjs'
import { getByPath, interpolate, interpolateDeep, extractByRegex, stringifyValue } from '../vars.mjs'

const MAX_BODY_BYTES = 2 * 1024 * 1024   // 超过则截断，避免把巨响应灌进内存/报告

function buildUrl(step, vars, baseUrl, missing) {
  const raw = interpolate(step.request?.url ?? '', vars, missing)
  if (/^https?:\/\//i.test(raw)) return { url: raw, query: step.request?.query }
  const base = (baseUrl ?? '').replace(/\/+$/, '')
  const path = raw.startsWith('/') ? raw : `/${raw}`
  return { url: `${base}${path}`, query: step.request?.query }
}

function applyQuery(url, query, vars, missing) {
  const entries = Object.entries(query ?? {})
  if (!entries.length) return url
  const search = new URLSearchParams()
  for (const [k, v] of entries) {
    if (v === undefined || v === null || v === '') continue
    search.append(interpolate(k, vars, missing), interpolate(String(v), vars, missing))
  }
  const qs = search.toString()
  if (!qs) return url
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`
}

function buildBody(step, vars, missing) {
  const mode = step.request?.bodyMode ?? 'none'
  if (mode === 'none') return { body: undefined, headers: {} }
  const raw = interpolate(step.request?.body ?? '', vars, missing)
  if (mode === 'json') {
    let body = raw
    try {
      body = JSON.stringify(JSON.parse(raw))
    } catch { /* 用户可能故意发非法 JSON，原样发送 */ }
    return { body, headers: { 'content-type': 'application/json' } }
  }
  if (mode === 'form') {
    const pairs = new URLSearchParams()
    // 支持 "a=1&b=2" 或 JSON 对象两种写法
    try {
      const obj = JSON.parse(raw)
      for (const [k, v] of Object.entries(obj)) pairs.append(k, stringifyValue(v))
    } catch {
      for (const chunk of raw.split('&')) {
        const [k, ...rest] = chunk.split('=')
        if (k) pairs.append(k.trim(), rest.join('='))
      }
    }
    return { body: pairs.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }
  }
  return { body: raw, headers: { 'content-type': 'text/plain; charset=utf-8' } }
}

async function performRequest(step, vars, baseUrl, missing) {
  const { url: rawUrl, query } = buildUrl(step, vars, baseUrl, missing)
  const url = applyQuery(rawUrl, query, vars, missing)
  const { body, headers: bodyHeaders } = buildBody(step, vars, missing)
  const headers = {
    ...Object.fromEntries(Object.entries(bodyHeaders)),
    ...interpolateDeep(step.request?.headers ?? {}, vars, missing),
  }
  const method = (step.request?.method ?? 'GET').toUpperCase()
  const timeoutMs = Number(step.request?.timeoutMs ?? 15000)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  const record = { method, url, headers, body }
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: controller.signal,
      redirect: 'follow',
    })

    // 流式读取并限制大小：超大响应不会被整包读进内存，只保留前 MAX_BODY_BYTES。
    const chunks = []
    let received = 0
    let truncated = false
    const reader = response.body?.getReader()
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (received + value.length >= MAX_BODY_BYTES) {
          chunks.push(value.subarray(0, MAX_BODY_BYTES - received))
          received = MAX_BODY_BYTES
          truncated = true
          await reader.cancel().catch(() => {})
          break
        }
        chunks.push(value)
        received += value.length
      }
    }
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const durationMs = Date.now() - startedAt

    // 尽量解析 JSON：截断的响应体可能解析失败，此时 jsonPath 断言会给出明确失败原因，
    // 但 bodyContains / 状态码 / 响应时间等断言仍然可用。
    let json
    try {
      json = JSON.parse(bodyText)
    } catch {
      json = undefined
    }
    return {
      ok: true,
      durationMs,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      bodyText,
      bodySize: Number(response.headers.get('content-length') ?? received) || received,
      truncated,
      json,
      request: record,
    }
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error?.name === 'AbortError' ? `请求超时（>${timeoutMs}ms）` : (error?.message ?? String(error)),
      request: record,
    }
  } finally {
    clearTimeout(timer)
  }
}

function runExtracts(extract = [], response, vars, logs) {
  const extracted = {}
  for (const rule of extract) {
    if (!rule?.name) continue
    let value
    if (rule.from === 'header') {
      const key = String(rule.path ?? '').toLowerCase()
      value = Object.entries(response.headers ?? {}).find(([k]) => k.toLowerCase() === key)?.[1]
    } else if (rule.from === 'text') {
      value = rule.regex ? extractByRegex(response.bodyText, rule.regex, rule.group ?? 1) : response.bodyText
    } else {
      value = getByPath(response.json, rule.path)
    }
    if (value === undefined) {
      logs.push(`⚠️ 抽取变量 ${rule.name} 失败（from=${rule.from} path=${rule.path ?? ''}）`)
      continue
    }
    vars[rule.name] = stringifyValue(value)
    extracted[rule.name] = vars[rule.name]
    logs.push(`🔗 抽取变量 ${rule.name} = ${vars[rule.name].slice(0, 120)}`)
  }
  return extracted
}

/**
 * 执行一个 API 用例。
 * @param {object} testCase 用例定义
 * @param {object} options { vars, baseUrl, emit, runId, artifactDir }
 */
export async function runApiCase(testCase, options) {
  const { baseUrl, emit } = options
  const vars = { ...(options.vars ?? {}) }
  const missing = new Set()
  const stepResults = []
  const caseLogs = []
  const startedAt = Date.now()
  let status = 'passed'
  let caseError

  for (const [index, step] of (testCase.steps ?? []).entries()) {
    const stepStarted = Date.now()
    const logs = []
    const stepResult = {
      stepId: step.id ?? `step-${index + 1}`,
      name: step.name || `步骤 ${index + 1}`,
      status: 'passed',
      durationMs: 0,
      assertions: [],
      logs,
      screenshots: [],
    }
    emit?.({ type: 'step:start', caseId: testCase.id, stepId: stepResult.stepId, name: stepResult.name })

    const response = await performRequest(step, vars, baseUrl, missing)
    if (!response.ok) {
      stepResult.status = 'error'
      stepResult.error = response.error
      logs.push(`❌ 请求失败：${response.error}`)
      stepResult.request = response.request
    } else {
      stepResult.request = response.request
      stepResult.response = {
        status: response.status,
        headers: response.headers,
        bodyPreview: response.bodyText.slice(0, 4000),
        bodySize: response.bodySize,
        truncated: response.truncated,
      }
      logs.push(`${response.request.method} ${response.request.url} → ${response.status}（${response.durationMs}ms，${response.bodySize} 字节）`)
      emit?.({ type: 'step:log', caseId: testCase.id, stepId: stepResult.stepId, level: 'info', message: logs.at(-1) })
    }

    if (response.ok) {
      const extracted = runExtracts(step.extract, response, vars, logs)
      for (const line of logs.slice(1)) emit?.({ type: 'step:log', caseId: testCase.id, stepId: stepResult.stepId, level: 'info', message: line })
      if (Object.keys(extracted).length) stepResult.extracted = extracted

      const { results, ok } = evaluateAssertions(step.assertions, {
        status: response.status,
        responseTimeMs: response.durationMs,
        headers: response.headers,
        bodyText: response.bodyText,
        json: response.json,
      })
      stepResult.assertions = results
      for (const r of results) {
        emit?.({ type: 'assertion', caseId: testCase.id, stepId: stepResult.stepId, result: r })
      }
      if (!ok) {
        stepResult.status = 'failed'
        for (const r of results.filter((x) => !x.ok)) logs.push(`❌ ${r.label}：${r.message}`)
      }
    }

    stepResult.durationMs = Date.now() - stepStarted
    stepResults.push(stepResult)
    emit?.({ type: 'step:end', caseId: testCase.id, stepId: stepResult.stepId, status: stepResult.status, durationMs: stepResult.durationMs })

    if (stepResult.status !== 'passed' && !step.continueOnFail) {
      status = stepResult.status
      break
    }
    if (stepResult.status !== 'passed') status = stepResult.status
  }

  if (missing.size) caseLogs.push(`⚠️ 未定义变量：${[...missing].join(', ')}（请在项目变量或用例变量里补齐）`)

  return {
    caseId: testCase.id,
    name: testCase.name,
    type: testCase.type,
    tags: testCase.tags ?? [],
    status,
    durationMs: Date.now() - startedAt,
    startedAt,
    finishedAt: Date.now(),
    steps: stepResults,
    logs: caseLogs,
    screenshots: [],
    error: caseError,
    variables: vars,
  }
}
