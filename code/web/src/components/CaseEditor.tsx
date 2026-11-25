/**
 * 用例编辑器：表单化编辑 API / Web 用例（公共字段 + 步骤 + 断言 + 变量抽取）。
 * 不暴露 JSON 文本编辑，全部用下拉框与输入框完成。
 */
import { useMemo, useState } from 'react'
import * as api from '../api'
import { errorMessage } from '../api'
import { localId, parseTags, tagsToText } from '../format'
import type {
  ApiStep,
  Assertion,
  AssertionOp,
  AssertionType,
  AssertionTypeMeta,
  CaseDraft,
  CaseType,
  ExtractRule,
  Step,
  TestCase,
  WebActionType,
  WebStep,
} from '../types'
import { KeyValueEditor, Notice } from './ui'

type Props = {
  projectId: string
  /** 正在编辑的用例；null 表示新建 */
  editing: TestCase | null
  assertionTypes: Record<string, AssertionTypeMeta>
  assertionOps: Record<string, string>
  onSaved: (testCase: TestCase, created: boolean) => void
  onCancel: () => void
}

const WEB_ACTIONS: { value: WebActionType; label: string; hint: string }[] = [
  { value: 'goto', label: '打开页面 goto', hint: '在「URL/值」里填地址（相对路径会拼 baseUrl）' },
  { value: 'fill', label: '输入文本 fill', hint: '需要选择器 + 值' },
  { value: 'click', label: '点击 click', hint: '需要选择器' },
  { value: 'select', label: '下拉选择 select', hint: '需要选择器 + 值' },
  { value: 'press', label: '按键 press', hint: '选择器可选，值填 Enter 等键名' },
  { value: 'hover', label: '鼠标悬停 hover', hint: '需要选择器' },
  { value: 'check', label: '勾选 check', hint: '需要选择器' },
  { value: 'waitForSelector', label: '等待元素出现 waitForSelector', hint: '需要选择器，可填超时毫秒' },
  { value: 'waitForTimeout', label: '固定等待 waitForTimeout', hint: '只需填等待毫秒' },
  { value: 'screenshot', label: '手动截图 screenshot', hint: '无参数，立即截一张图' },
]

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const BODY_MODES: { value: 'none' | 'json' | 'text' | 'form'; label: string }[] = [
  { value: 'none', label: '无请求体' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: '纯文本' },
  { value: 'form', label: '表单 (x-www-form-urlencoded)' },
]

const EMPTY_ASSERTION_OP: AssertionOp = 'equals'

/** 断言类型推荐比较符（与后端 OP_DEFAULT 对齐，仅作默认值）。 */
const OP_DEFAULT: Partial<Record<AssertionType, AssertionOp>> = {
  status: 'equals',
  jsonPath: 'equals',
  bodyContains: 'contains',
  bodyMatches: 'matches',
  headerContains: 'contains',
  responseTime: 'lte',
  urlContains: 'contains',
  elementVisible: 'truthy',
  elementText: 'contains',
  elementCount: 'gte',
}

function newApiStep(index: number): ApiStep {
  return {
    id: localId('step'),
    name: `步骤 ${index}`,
    continueOnFail: false,
    screenshot: false,
    request: { method: 'GET', url: '/', headers: {}, query: {}, bodyMode: 'none', body: '', timeoutMs: 15000 },
    extract: [],
    assertions: [],
  }
}

function newWebStep(index: number): WebStep {
  return {
    id: localId('step'),
    name: `步骤 ${index}`,
    continueOnFail: false,
    screenshot: false,
    action: { type: 'goto', url: '/', selector: '', value: '', ms: 500 },
    assertions: [],
  }
}

function newAssertion(type: AssertionType): Assertion {
  return { id: localId('a'), type, op: OP_DEFAULT[type] ?? EMPTY_ASSERTION_OP, path: '', selector: '', expected: '' }
}

/** 把后端用例转成可编辑副本（补齐缺失字段，避免受控组件 undefined）。 */
function toDraft(testCase: TestCase | null, type: CaseType): CaseDraft {
  if (!testCase) {
    return {
      name: '',
      type,
      description: '',
      tags: [],
      enabled: true,
      variables: {},
      timeoutMs: 15000,
      steps: [type === 'web' ? newWebStep(1) : newApiStep(1)],
    }
  }
  return {
    id: testCase.id,
    name: testCase.name,
    type: testCase.type ?? type,
    description: testCase.description ?? '',
    tags: testCase.tags ?? [],
    enabled: testCase.enabled !== false,
    variables: testCase.variables ?? {},
    timeoutMs: testCase.timeoutMs ?? 15000,
    steps: (testCase.steps ?? []).map((step, index) => {
      if (testCase.type === 'web') {
        const web = step as WebStep
        return {
          id: step.id ?? localId('step'),
          name: step.name || `步骤 ${index + 1}`,
          continueOnFail: Boolean(step.continueOnFail),
          screenshot: Boolean(step.screenshot),
          action: { type: 'goto', ...(web.action ?? {}) },
          assertions: (step.assertions ?? []).map((a) => ({ ...a, id: a.id ?? localId('a') })),
        } as WebStep
      }
      const apis = step as ApiStep
      return {
        id: step.id ?? localId('step'),
        name: step.name || `步骤 ${index + 1}`,
        continueOnFail: Boolean(step.continueOnFail),
        screenshot: Boolean(step.screenshot),
        request: {
          method: apis.request?.method ?? 'GET',
          url: apis.request?.url ?? '/',
          headers: apis.request?.headers ?? {},
          query: apis.request?.query ?? {},
          bodyMode: apis.request?.bodyMode ?? 'none',
          body: apis.request?.body ?? '',
          timeoutMs: apis.request?.timeoutMs ?? 15000,
        },
        extract: apis.extract ?? [],
        assertions: (step.assertions ?? []).map((a) => ({ ...a, id: a.id ?? localId('a') })),
      } as ApiStep
    }),
  }
}

export default function CaseEditor({ projectId, editing, assertionTypes, assertionOps, onSaved, onCancel }: Props) {
  const initialType: CaseType = editing?.type ?? 'api'
  const [form, setForm] = useState<CaseDraft>(() => toDraft(editing, initialType))
  const [tagsText, setTagsText] = useState(() => tagsToText(editing?.tags))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const type = form.type
  const steps = form.steps

  /** 按 scope 过滤出当前类型可用的断言类型。 */
  const availableTypes = useMemo(
    () =>
      Object.entries(assertionTypes ?? {})
        .filter(([, meta]) => !meta?.scope || meta.scope === type)
        .map(([value, meta]) => ({ value: value as AssertionType, ...meta })),
    [assertionTypes, type],
  )
  const opEntries = useMemo(() => Object.entries(assertionOps ?? {}), [assertionOps])

  const patch = (next: Partial<CaseDraft>) => setForm((prev) => ({ ...prev, ...next }))

  const patchStep = (index: number, next: Partial<ApiStep & WebStep>) =>
    setForm((prev) => {
      const list = [...prev.steps]
      list[index] = { ...list[index], ...next } as Step
      return { ...prev, steps: list }
    })

  const switchType = (nextType: CaseType) => {
    if (nextType === type) return
    const previous = steps.length
    setForm((prev) => ({
      ...prev,
      type: nextType,
      steps: nextType === 'web' ? prev.steps.map((_, i) => newWebStep(i + 1)) : prev.steps.map((_, i) => newApiStep(i + 1)),
    }))
    setError(
      previous > 0
        ? `已切换为 ${nextType === 'web' ? 'Web' : 'API'} 用例，原有步骤的字段已按新类型重置，请重新填写。`
        : '',
    )
  }

  const addStep = () =>
    setForm((prev) => ({
      ...prev,
      steps: [...prev.steps, prev.type === 'web' ? newWebStep(prev.steps.length + 1) : newApiStep(prev.steps.length + 1)],
    }))

  const removeStep = (index: number) =>
    setForm((prev) => ({ ...prev, steps: prev.steps.filter((_, i) => i !== index) }))

  const moveStep = (index: number, delta: number) =>
    setForm((prev) => {
      const target = index + delta
      if (target < 0 || target >= prev.steps.length) return prev
      const list = [...prev.steps]
      const [item] = list.splice(index, 1)
      list.splice(target, 0, item)
      return { ...prev, steps: list }
    })

  const setStepAssertions = (index: number, assertions: Assertion[]) => patchStep(index, { assertions })

  const submit = async () => {
    setError('')
    if (!form.name.trim()) {
      setError('用例名称不能为空')
      return
    }
    if (steps.length === 0) {
      setError('用例至少需要一个步骤')
      return
    }
    for (const [i, step] of steps.entries()) {
      if (type === 'api' && !(step as ApiStep).request?.url?.trim()) {
        setError(`第 ${i + 1} 步缺少请求地址（URL）`)
        return
      }
      if (type === 'web' && !(step as WebStep).action?.type) {
        setError(`第 ${i + 1} 步缺少页面动作`)
        return
      }
    }
    const draft: CaseDraft = {
      ...form,
      name: form.name.trim(),
      tags: parseTags(tagsText),
      timeoutMs: Number(form.timeoutMs) || undefined,
    }
    setBusy(true)
    try {
      const saved = editing ? await api.updateCase(editing.id, draft) : await api.createCase(projectId, draft)
      onSaved(saved, !editing)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card editor">
      <header className="card__head">
        <h2 className="card__title">{editing ? `编辑用例：${editing.name}` : '新建用例'}</h2>
        <div className="card__actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            返回列表
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : '保存用例'}
          </button>
        </div>
      </header>

      {error ? <Notice tone="error" onClose={() => setError('')}>{error}</Notice> : null}

      <div className="editor__section">
        <h3 className="section-title">基本信息</h3>
        <div className="grid grid--2">
          <label className="field">
            <span className="field__label">用例名称 *</span>
            <input
              className="input"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="例如：登录接口返回 token"
            />
          </label>
          <label className="field">
            <span className="field__label">用例类型</span>
            <select className="input" value={type} onChange={(e) => switchType(e.target.value as CaseType)}>
              <option value="api">API（HTTP 接口）</option>
              <option value="web">Web（浏览器 UI）</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">标签（逗号分隔，运行时可筛选）</span>
            <input
              className="input"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="smoke, login"
            />
          </label>
          <label className="field">
            <span className="field__label">用例超时（毫秒）</span>
            <input
              className="input input--mono"
              type="number"
              min={0}
              value={form.timeoutMs ?? ''}
              onChange={(e) => patch({ timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </label>
        </div>
        <label className="field">
          <span className="field__label">描述</span>
          <textarea
            className="input"
            rows={2}
            value={form.description ?? ''}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="这个用例验证什么"
          />
        </label>
        <label className="field field--inline">
          <input
            type="checkbox"
            checked={form.enabled !== false}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>启用该用例（未启用时「运行全部」会跳过）</span>
        </label>
        <div className="field">
          <span className="field__label">用例级变量（覆盖项目变量）</span>
          <KeyValueEditor
            value={form.variables}
            onChange={(next) => patch({ variables: next })}
            keyPlaceholder="变量名"
            valuePlaceholder="变量值"
            addText="添加变量"
            emptyText="暂无用例级变量"
          />
        </div>
      </div>

      <div className="editor__section">
        <div className="section-head">
          <h3 className="section-title">步骤（{steps.length}）</h3>
          <button type="button" className="btn btn--small" onClick={addStep}>
            + 添加步骤
          </button>
        </div>

        {steps.length === 0 ? <div className="muted">还没有步骤，点「添加步骤」开始。</div> : null}

        {steps.map((step, index) => {
          const apiStep = step as ApiStep
          const webStep = step as WebStep
          return (
            <div className="step-card" key={step.id ?? index}>
              <header className="step-card__head">
                <span className="step-card__index">#{index + 1}</span>
                <input
                  className="input input--title"
                  value={step.name}
                  onChange={(e) => patchStep(index, { name: e.target.value })}
                  placeholder="步骤名称"
                />
                <div className="step-card__tools">
                  <button
                    type="button"
                    className="icon-btn"
                    title="上移"
                    aria-label="上移"
                    onClick={() => moveStep(index, -1)}
                    disabled={index === 0}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="下移"
                    aria-label="下移"
                    onClick={() => moveStep(index, 1)}
                    disabled={index === steps.length - 1}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    title="删除步骤"
                    aria-label="删除步骤"
                    onClick={() => removeStep(index)}
                  >
                    🗑
                  </button>
                </div>
              </header>

              {type === 'api' ? (
                <div className="grid grid--2">
                  <label className="field">
                    <span className="field__label">请求方法</span>
                    <select
                      className="input"
                      value={apiStep.request?.method ?? 'GET'}
                      onChange={(e) =>
                        patchStep(index, { request: { ...apiStep.request!, method: e.target.value } } as Partial<ApiStep>)
                      }
                    >
                      {METHODS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field__label">请求地址 URL *（相对路径会拼项目 baseUrl）</span>
                    <input
                      className="input input--mono"
                      value={apiStep.request?.url ?? ''}
                      onChange={(e) => patchStep(index, { request: { ...apiStep.request!, url: e.target.value } } as Partial<ApiStep>)}
                      placeholder="/api/login 或 http://host/path"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">超时（毫秒）</span>
                    <input
                      className="input input--mono"
                      type="number"
                      min={0}
                      value={apiStep.request?.timeoutMs ?? 15000}
                      onChange={(e) =>
                        patchStep(index, {
                          request: { ...apiStep.request!, timeoutMs: Number(e.target.value) || 0 },
                        } as Partial<ApiStep>)
                      }
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">请求体类型</span>
                    <select
                      className="input"
                      value={apiStep.request?.bodyMode ?? 'none'}
                      onChange={(e) =>
                        patchStep(index, {
                          request: { ...apiStep.request!, bodyMode: e.target.value as 'none' | 'json' | 'text' | 'form' },
                        } as Partial<ApiStep>)
                      }
                    >
                      {BODY_MODES.map((mode) => (
                        <option key={mode.value} value={mode.value}>
                          {mode.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="field field--full">
                    <span className="field__label">请求头</span>
                    <KeyValueEditor
                      value={apiStep.request?.headers}
                      onChange={(next) => patchStep(index, { request: { ...apiStep.request!, headers: next } } as Partial<ApiStep>)}
                      keyPlaceholder="Header 名，如 content-type"
                      valuePlaceholder="Header 值"
                      addText="添加请求头"
                      emptyText="暂无请求头"
                    />
                  </div>
                  <div className="field field--full">
                    <span className="field__label">查询参数（query）</span>
                    <KeyValueEditor
                      value={apiStep.request?.query}
                      onChange={(next) => patchStep(index, { request: { ...apiStep.request!, query: next } } as Partial<ApiStep>)}
                      keyPlaceholder="参数名"
                      valuePlaceholder="参数值"
                      addText="添加参数"
                      emptyText="暂无查询参数"
                    />
                  </div>
                  {(apiStep.request?.bodyMode ?? 'none') !== 'none' ? (
                    <label className="field field--full">
                      <span className="field__label">请求体内容</span>
                      <textarea
                        className="input input--mono"
                        rows={5}
                        value={apiStep.request?.body ?? ''}
                        onChange={(e) => patchStep(index, { request: { ...apiStep.request!, body: e.target.value } } as Partial<ApiStep>)}
                        placeholder={'{"username":"{{user}}","password":"123456"}'}
                      />
                    </label>
                  ) : null}
                </div>
              ) : (
                <div className="grid grid--2">
                  <label className="field">
                    <span className="field__label">页面动作</span>
                    <select
                      className="input"
                      value={webStep.action?.type ?? 'goto'}
                      onChange={(e) =>
                        patchStep(index, { action: { ...webStep.action!, type: e.target.value as WebActionType } } as Partial<WebStep>)
                      }
                    >
                      {WEB_ACTIONS.map((action) => (
                        <option key={action.value} value={action.value}>
                          {action.label}
                        </option>
                      ))}
                    </select>
                    <span className="field__hint">
                      {WEB_ACTIONS.find((a) => a.value === (webStep.action?.type ?? 'goto'))?.hint}
                    </span>
                  </label>
                  <label className="field">
                    <span className="field__label">选择器 selector</span>
                    <input
                      className="input input--mono"
                      value={webStep.action?.selector ?? ''}
                      onChange={(e) =>
                        patchStep(index, { action: { ...webStep.action!, selector: e.target.value } } as Partial<WebStep>)
                      }
                      placeholder="#username / text=登录"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">值 / 文本</span>
                    <input
                      className="input input--mono"
                      value={webStep.action?.value ?? ''}
                      onChange={(e) => patchStep(index, { action: { ...webStep.action!, value: e.target.value } } as Partial<WebStep>)}
                      placeholder="要输入的内容或按键名（Enter）"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">URL（goto 用）</span>
                    <input
                      className="input input--mono"
                      value={webStep.action?.url ?? ''}
                      onChange={(e) => patchStep(index, { action: { ...webStep.action!, url: e.target.value } } as Partial<WebStep>)}
                      placeholder="/login"
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">等待毫秒 ms（waitFor* 用）</span>
                    <input
                      className="input input--mono"
                      type="number"
                      min={0}
                      value={webStep.action?.ms ?? ''}
                      onChange={(e) =>
                        patchStep(index, {
                          action: { ...webStep.action!, ms: e.target.value === '' ? undefined : Number(e.target.value) },
                        } as Partial<WebStep>)
                      }
                    />
                  </label>
                </div>
              )}

              <div className="step-card__flags">
                <label className="field field--inline">
                  <input
                    type="checkbox"
                    checked={Boolean(step.continueOnFail)}
                    onChange={(e) => patchStep(index, { continueOnFail: e.target.checked })}
                  />
                  <span>失败后继续执行后续步骤</span>
                </label>
                {type === 'web' ? (
                  <label className="field field--inline">
                    <input
                      type="checkbox"
                      checked={Boolean(step.screenshot)}
                      onChange={(e) => patchStep(index, { screenshot: e.target.checked })}
                    />
                    <span>该步骤截图（失败时总是截图）</span>
                  </label>
                ) : null}
              </div>

              {/* 断言 */}
              <div className="sub-block">
                <div className="section-head">
                  <h4 className="section-title section-title--sub">
                    断言（{(step.assertions ?? []).length}）
                  </h4>
                  <button
                    type="button"
                    className="btn btn--small"
                    onClick={() =>
                      setStepAssertions(index, [
                        ...(step.assertions ?? []),
                        newAssertion((availableTypes[0]?.value ?? 'status') as AssertionType),
                      ])
                    }
                    disabled={availableTypes.length === 0}
                  >
                    + 添加断言
                  </button>
                </div>
                {(step.assertions ?? []).length === 0 ? <div className="muted">暂无断言</div> : null}
                {(step.assertions ?? []).map((assertion, ai) => {
                  const meta = assertionTypes[assertion.type]
                  const needPath = Boolean(meta?.needsPath)
                  const pathLabel =
                    assertion.type === 'headerContains'
                      ? '响应头名称'
                      : assertion.type === 'jsonPath'
                        ? 'JSON 路径'
                        : '路径（如 $.data.id）'
                  const updateAssertion = (next: Partial<Assertion>) =>
                    setStepAssertions(
                      index,
                      (step.assertions ?? []).map((item, i) => (i === ai ? { ...item, ...next } : item)),
                    )
                  return (
                    <div className="assertion-row" key={assertion.id}>
                      <select
                        className="input"
                        value={assertion.type}
                        onChange={(e) => {
                          const nextType = e.target.value as AssertionType
                          updateAssertion({ type: nextType, op: OP_DEFAULT[nextType] ?? EMPTY_ASSERTION_OP })
                        }}
                      >
                        {availableTypes.map((item) => (
                          <option key={item.value} value={item.value}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <select
                        className="input"
                        value={assertion.op}
                        onChange={(e) => updateAssertion({ op: e.target.value as AssertionOp })}
                      >
                        {opEntries.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <input
                        className="input input--mono"
                        value={assertion.path ?? ''}
                        onChange={(e) => updateAssertion({ path: e.target.value })}
                        placeholder={needPath ? pathLabel : '路径（可留空）'}
                      />
                      <input
                        className="input input--mono"
                        value={assertion.expected ?? ''}
                        onChange={(e) => updateAssertion({ expected: e.target.value })}
                        placeholder="期望值"
                      />
                      <button
                        type="button"
                        className="icon-btn icon-btn--danger"
                        title="删除断言"
                        aria-label="删除断言"
                        onClick={() =>
                          setStepAssertions(
                            index,
                            (step.assertions ?? []).filter((_, i) => i !== ai),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>

              {/* 变量抽取（仅 API 步骤） */}
              {type === 'api' ? (
                <div className="sub-block">
                  <div className="section-head">
                    <h4 className="section-title section-title--sub">
                      变量抽取（{(apiStep.extract ?? []).length}）—— 把响应里的值存成变量供后续步骤使用
                    </h4>
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() =>
                        patchStep(index, {
                          extract: [...(apiStep.extract ?? []), { name: '', from: 'json', path: '', regex: '', group: 1 }],
                        } as Partial<ApiStep>)
                      }
                    >
                      + 添加抽取
                    </button>
                  </div>
                  {(apiStep.extract ?? []).length === 0 ? <div className="muted">暂无抽取规则</div> : null}
                  {(apiStep.extract ?? []).map((rule, ri) => {
                    const updateRule = (next: Partial<ExtractRule>) =>
                      patchStep(index, {
                        extract: (apiStep.extract ?? []).map((item, i) => (i === ri ? { ...item, ...next } : item)),
                      } as Partial<ApiStep>)
                    return (
                      <div className="assertion-row assertion-row--extract" key={`${rule.name}-${ri}`}>
                        <input
                          className="input input--mono"
                          value={rule.name}
                          onChange={(e) => updateRule({ name: e.target.value })}
                          placeholder="变量名，如 token"
                        />
                        <select
                          className="input"
                          value={rule.from}
                          onChange={(e) => updateRule({ from: e.target.value as ExtractRule['from'] })}
                        >
                          <option value="json">从 JSON</option>
                          <option value="header">从响应头</option>
                          <option value="text">从正文正则</option>
                        </select>
                        <input
                          className="input input--mono"
                          value={rule.from === 'text' ? rule.regex ?? '' : rule.path ?? ''}
                          onChange={(e) =>
                            updateRule(rule.from === 'text' ? { regex: e.target.value } : { path: e.target.value })
                          }
                          placeholder={rule.from === 'text' ? '正则，如 token":"([^"]+)' : rule.from === 'header' ? '响应头名' : 'JSON 路径 $.data.token'}
                        />
                        <input
                          className="input input--mono"
                          type="number"
                          min={0}
                          value={rule.group ?? 1}
                          onChange={(e) => updateRule({ group: Number(e.target.value) || 0 })}
                          disabled={rule.from !== 'text'}
                          title="正则捕获组序号"
                        />
                        <button
                          type="button"
                          className="icon-btn icon-btn--danger"
                          title="删除抽取"
                          aria-label="删除抽取"
                          onClick={() =>
                            patchStep(index, {
                              extract: (apiStep.extract ?? []).filter((_, i) => i !== ri),
                            } as Partial<ApiStep>)
                          }
                        >
                          ×
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <footer className="editor__foot">
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          返回列表
        </button>
        <button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
          {busy ? '保存中…' : '保存用例'}
        </button>
      </footer>
    </section>
  )
}
