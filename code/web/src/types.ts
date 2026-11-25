/**
 * 数据模型：与后端 server/src 保持一致的 TypeScript 类型定义。
 * 后端契约见 code/server/src/index.mjs。
 */

/** 项目 */
export type Project = {
  id: string
  name: string
  description: string
  baseUrl: string
  variables: Record<string, string>
  createdAt: number
  updatedAt: number
  caseCount?: number
}

/** 项目草稿（新建 / 编辑提交给后端的字段） */
export type ProjectDraft = {
  name: string
  description?: string
  baseUrl?: string
  variables?: Record<string, string>
}

export type AssertionType =
  | 'status'
  | 'jsonPath'
  | 'bodyContains'
  | 'bodyMatches'
  | 'headerContains'
  | 'responseTime'
  | 'urlContains'
  | 'elementVisible'
  | 'elementText'
  | 'elementCount'

export type AssertionOp =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'matches'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'exists'
  | 'truthy'

export type Assertion = {
  id: string
  type: AssertionType
  op: AssertionOp
  path?: string
  selector?: string
  expected?: string
  name?: string
}

/** 变量抽取规则（仅 API 步骤） */
export type ExtractRule = {
  name: string
  from: 'json' | 'header' | 'text'
  path?: string
  regex?: string
  group?: number
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export type ApiRequest = {
  method: string
  url: string
  headers?: Record<string, string>
  query?: Record<string, string>
  bodyMode?: 'none' | 'json' | 'text' | 'form'
  body?: string
  timeoutMs?: number
}

export type WebActionType =
  | 'goto'
  | 'fill'
  | 'click'
  | 'select'
  | 'press'
  | 'waitForSelector'
  | 'waitForTimeout'
  | 'screenshot'
  | 'hover'
  | 'check'

export type WebAction = {
  type: WebActionType
  selector?: string
  value?: string
  url?: string
  ms?: number
}

export type ApiStep = {
  id: string
  name: string
  screenshot?: boolean
  continueOnFail?: boolean
  request?: ApiRequest
  extract?: ExtractRule[]
  assertions?: Assertion[]
}

export type WebStep = {
  id: string
  name: string
  screenshot?: boolean
  continueOnFail?: boolean
  action?: WebAction
  assertions?: Assertion[]
}

export type Step = ApiStep | WebStep

export type CaseType = 'api' | 'web'

export type TestCase = {
  id: string
  projectId: string
  name: string
  type: CaseType
  description: string
  tags: string[]
  enabled: boolean
  variables: Record<string, string>
  timeoutMs?: number
  steps: Step[]
  createdAt: number
  updatedAt: number
}

/** 用例草稿：新建（无 id）/ 编辑（带 id）提交给后端的结构 */
export type CaseDraft = {
  id?: string
  name: string
  type: CaseType
  description?: string
  tags?: string[]
  enabled?: boolean
  variables?: Record<string, string>
  timeoutMs?: number
  steps: Step[]
}

/** 断言结果 */
export type AssertionResult = {
  assertionId: string
  type: string
  op: string
  label: string
  expected: string
  actual: string
  ok: boolean
  message: string
}

export type StepStatus = 'passed' | 'failed' | 'error' | 'skipped'

export type StepResult = {
  stepId: string
  name: string
  status: StepStatus
  durationMs: number
  request?: { method: string; url: string; headers?: Record<string, string>; body?: string }
  response?: { status: number; headers: Record<string, string>; bodyPreview: string; bodySize: number; truncated?: boolean }
  assertions: AssertionResult[]
  logs: string[]
  screenshots: string[]
  error?: string
  extracted?: Record<string, string>
  pageUrl?: string
}

export type CaseResult = {
  caseId: string
  name: string
  type: CaseType
  tags: string[]
  status: string
  durationMs: number
  steps: StepResult[]
  logs: string[]
  screenshots: string[]
  error?: string
}

export type RunSummaryStats = {
  total: number
  passed: number
  failed: number
  error: number
  skipped: number
  durationMs: number
}

export type RunCaseBrief = {
  caseId: string
  name: string
  type: string
  status: string
  durationMs: number
  failedAssertions: number
  screenshots: string[]
}

export type RunSummary = {
  id: string
  projectId: string
  projectName?: string
  name: string
  status: string
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  summary: RunSummaryStats
  cases: RunCaseBrief[]
}

export type Run = RunSummary & {
  results: CaseResult[]
  active?: boolean
  variables?: Record<string, string>
  error?: string
}

/** 健康检查返回（含断言类型/比较符字典，界面下拉框数据源） */
export type AssertionTypeMeta = {
  label: string
  scope: 'api' | 'web'
  needsPath: boolean
}

export type Health = {
  ok: boolean
  name: string
  version: string
  time: number
  dataDir: string
  webBuilt: boolean
  browsersReady: boolean
  assertionTypes: Record<string, AssertionTypeMeta>
  assertionOps: Record<string, string>
}

/** 内置示例清单项 */
export type ExampleItem = {
  id: string
  name: string
  caseCount: number
  readme: string
}

/** SSE 事件（type 判别联合，未列举的字段按需读取）
 *  - `replay: true`：后端在 snapshot 之后回放的历史事件（用于消除晚订阅的竞态）
 */
export type RunEvent = (
  | { seq: number; time: number; runId: string; type: 'snapshot'; status: string; summary: RunSummaryStats; results: CaseResult[] }
  | { seq: number; time: number; runId: string; type: 'run:start'; run: { id: string; name: string; total: number; projectId: string } }
  | { seq: number; time: number; runId: string; type: 'run:log'; level: LogLevel; message: string }
  | { seq: number; time: number; runId: string; type: 'case:start'; caseId: string; name: string; /** 用例类型 api/web */ caseType: CaseType; index: number; total: number }
  | { seq: number; time: number; runId: string; type: 'step:start'; caseId: string; stepId: string; name: string }
  | { seq: number; time: number; runId: string; type: 'step:log'; caseId: string; stepId: string; level: LogLevel; message: string }
  | { seq: number; time: number; runId: string; type: 'assertion'; caseId: string; stepId: string; result: AssertionResult }
  | { seq: number; time: number; runId: string; type: 'step:end'; caseId: string; stepId: string; status: StepStatus; durationMs: number }
  | { seq: number; time: number; runId: string; type: 'case:end'; caseId: string; name: string; status: string; durationMs: number; summary: RunSummaryStats; result: CaseResult }
  | { seq: number; time: number; runId: string; type: 'run:end'; status: string; summary: RunSummaryStats; durationMs: number }
) & { /** 后端回放的历史事件标记 */ replay?: boolean }

export type LogLevel = 'info' | 'warn' | 'error'

/** 导出文件结构 */
export type ExportBundle = {
  version: number
  project: Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'caseCount'>
  cases: TestCase[]
}
