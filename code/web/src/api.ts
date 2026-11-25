/**
 * 后端 API 统一封装：原生 fetch + 中文错误提示。
 *
 * 约定（见 code/server/src/http.mjs）：
 * - 成功：200 + JSON
 * - 失败：4xx/5xx + { error: '中文错误信息' }
 */
import type {
  AssertionOp,
  AssertionTypeMeta,
  CaseDraft,
  ExampleItem,
  ExportBundle,
  Health,
  Project,
  ProjectDraft,
  Run,
  RunSummary,
  TestCase,
} from './types'

const BASE = '/api'

/** 统一的接口错误：message 一定是可直接展示的中文文案。 */
export class ApiError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** 文件名，设置后触发浏览器下载（用于导出 JSON） */
  downloadName?: string
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, downloadName } = options
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    // 网络层失败：后端没起来、被防火墙拦、断网等
    throw new ApiError(`无法连接后端服务（${(error as Error)?.message ?? error}）。请确认服务已在 4519 端口启动。`, 0)
  }

  if (downloadName) {
    if (!response.ok) throw new ApiError(await readError(response), response.status)
    const text = await response.text()
    triggerDownload(text, downloadName)
    return undefined as T
  }

  const text = await response.text()
  let data: unknown = undefined
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      // 后端理论上总是返回 JSON；返回 HTML（例如 404 页面）时给出可读提示
      if (!response.ok) throw new ApiError(`后端返回了非 JSON 响应（HTTP ${response.status}）`, response.status)
      throw new ApiError('后端返回了非 JSON 响应，无法解析（可能访问到了错误的地址）', response.status)
    }
  }

  if (!response.ok) {
    const message = (data as { error?: string } | undefined)?.error
    throw new ApiError(message || `请求失败（HTTP ${response.status}）`, response.status)
  }
  return data as T
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string }
    return data?.error || `请求失败（HTTP ${response.status}）`
  } catch {
    return `请求失败（HTTP ${response.status}）`
  }
}

/** 前端直接下载文本（导出 JSON 用，不经过后端二次请求）。 */
function triggerDownload(text: string, filename: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 交给浏览器完成下载后再释放
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** 把任意异常转成可展示的中文文案。 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message || '未知错误'
  return String(error ?? '未知错误')
}

// ---------------------------------------------------------------- 健康检查

export const getHealth = () => request<Health>('/health')

// ---------------------------------------------------------------- 项目

export const listProjects = () => request<Project[]>('/projects')

export const getProject = (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`)

export const createProject = (draft: ProjectDraft) =>
  request<Project>('/projects', { method: 'POST', body: draft })

export const updateProject = (id: string, patch: Partial<ProjectDraft>) =>
  request<Project>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })

export const deleteProject = (id: string) =>
  request<{ ok: boolean }>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ---------------------------------------------------------------- 用例

export const listCases = (projectId: string) =>
  request<TestCase[]>(`/projects/${encodeURIComponent(projectId)}/cases`)

export const getCase = (id: string) => request<TestCase>(`/cases/${encodeURIComponent(id)}`)

export const createCase = (projectId: string, draft: CaseDraft) =>
  request<TestCase>(`/projects/${encodeURIComponent(projectId)}/cases`, { method: 'POST', body: draft })

export const updateCase = (id: string, draft: CaseDraft) =>
  request<TestCase>(`/cases/${encodeURIComponent(id)}`, { method: 'PUT', body: draft })

export const deleteCase = (id: string) =>
  request<{ ok: boolean }>(`/cases/${encodeURIComponent(id)}`, { method: 'DELETE' })

// ---------------------------------------------------------------- 执行

export type StartRunParams = {
  projectId: string
  caseIds?: string[]
  tags?: string[]
  variables?: Record<string, string>
  name?: string
}

export const startRun = (params: StartRunParams) =>
  request<{ runId: string; run: RunSummary }>('/runs', { method: 'POST', body: params })

export const listRuns = (projectId?: string, limit = 50) => {
  const search = new URLSearchParams()
  if (projectId) search.set('projectId', projectId)
  if (limit) search.set('limit', String(limit))
  const qs = search.toString()
  return request<RunSummary[]>(`/runs${qs ? `?${qs}` : ''}`)
}

export const getRun = (id: string) => request<Run>(`/runs/${encodeURIComponent(id)}`)

export const deleteRun = (id: string) =>
  request<{ ok: boolean }>(`/runs/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const cancelRun = (id: string) =>
  request<{ ok: boolean }>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })

/** SSE 事件流地址（交给 EventSource 订阅）。 */
export const runEventsUrl = (id: string) => `${BASE}/runs/${encodeURIComponent(id)}/events`

/** 自包含 HTML 报告地址（新窗口打开）。 */
export const runReportUrl = (id: string) => `${BASE}/runs/${encodeURIComponent(id)}/report`

/** 截图等产物地址（后端已返回 /api/artifacts/... 形式，这里做兜底拼接）。 */
export const artifactUrl = (runId: string, file: string) =>
  `${BASE}/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(file)}`

// ---------------------------------------------------------------- 导入导出

export const exportProject = (projectId: string) =>
  request<ExportBundle>(`/export?projectId=${encodeURIComponent(projectId)}`)

export const importBundle = (bundle: { project: unknown; cases: unknown[] }) =>
  request<{ project: Project; caseCount: number }>('/import', { method: 'POST', body: bundle })

export const listExamples = () => request<ExampleItem[]>('/examples')

export const importExample = (id: string) =>
  request<{ project: Project; caseCount: number }>(`/examples/${encodeURIComponent(id)}/import`, { method: 'POST' })

// ---------------------------------------------------------------- 工具

export const assertionTypeEntries = (types: Record<string, AssertionTypeMeta> | undefined) =>
  Object.entries(types ?? {}).map(([value, meta]) => ({ value, ...meta }))

export const assertionOpEntries = (ops: Record<string, string> | undefined) =>
  Object.entries(ops ?? {}).map(([value, label]) => ({ value: value as AssertionOp, label }))

/** 下载导出 JSON（走 api 层，统一错误处理）。 */
export function downloadExport(projectId: string, filename: string) {
  return request<void>(`/export?projectId=${encodeURIComponent(projectId)}`, {
    downloadName: filename.endsWith('.json') ? filename : `${filename}.json`,
  })
}
