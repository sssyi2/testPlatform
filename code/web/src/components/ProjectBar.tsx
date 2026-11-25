/**
 * 左侧项目栏：项目列表、新建/编辑/删除，以及底部的示例导入 / JSON 导入 / JSON 导出。
 */
import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { errorMessage } from '../api'
import type { ExampleItem, Project, ProjectDraft } from '../types'
import { ConfirmDialog, KeyValueEditor, Modal, Notice } from './ui'

type Props = {
  projects: Project[]
  currentId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onRefresh: (selectId?: string) => void
}

/** 项目表单（新建 / 编辑）。 */
function ProjectFormModal({
  project,
  onClose,
  onSaved,
}: {
  project: Project | null
  onClose: () => void
  onSaved: (project: Project, created: boolean) => void
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [baseUrl, setBaseUrl] = useState(project?.baseUrl ?? '')
  const [variables, setVariables] = useState<Record<string, string>>(project?.variables ?? {})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!name.trim()) {
      setError('项目名称不能为空')
      return
    }
    setBusy(true)
    setError('')
    try {
      const draft: ProjectDraft = { name: name.trim(), description, baseUrl: baseUrl.trim(), variables }
      const saved = project ? await api.updateProject(project.id, draft) : await api.createProject(draft)
      onSaved(saved, !project)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={project ? `编辑项目：${project.name}` : '新建项目'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      {error ? <Notice tone="error">{error}</Notice> : null}
      <label className="field">
        <span className="field__label">项目名称 *</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：示例商城" />
      </label>
      <label className="field">
        <span className="field__label">描述</span>
        <textarea
          className="input"
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="这个项目测什么"
        />
      </label>
      <label className="field">
        <span className="field__label">被测服务地址（baseUrl）</span>
        <input
          className="input input--mono"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://127.0.0.1:4600"
        />
        <span className="field__hint">用例里可用 {'{{baseUrl}}'} 引用；API 步骤的相对路径会自动拼接。</span>
      </label>
      <div className="field">
        <span className="field__label">项目变量（key = value，用例里用 {'{{key}}'} 引用）</span>
        <KeyValueEditor
          value={variables}
          onChange={setVariables}
          keyPlaceholder="变量名，如 token"
          valuePlaceholder="变量值"
          addText="添加变量"
          emptyText="暂无变量"
        />
      </div>
    </Modal>
  )
}

/** 示例清单模态框。 */
function ExamplesModal({
  examples,
  loading,
  error,
  importingId,
  onImport,
  onClose,
}: {
  examples: ExampleItem[]
  loading: boolean
  error: string
  importingId: string | null
  onImport: (item: ExampleItem) => void
  onClose: () => void
}) {
  return (
    <Modal title="导入内置示例项目" onClose={onClose} wide>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {loading ? <div className="muted">正在读取示例清单…</div> : null}
      {!loading && !error && examples.length === 0 ? (
        <div className="muted">
          后端还没有内置示例（需要 <code>code/examples/&lt;示例名&gt;/cases.json</code>）。
          你仍然可以「新建项目」从零开始，或用「导入 JSON」载入已有的用例文件。
        </div>
      ) : null}
      <div className="example-list">
        {examples.map((item) => (
          <div className="example-item" key={item.id}>
            <div className="example-item__main">
              <div className="example-item__name">{item.name}</div>
              <div className="example-item__meta">
                {item.caseCount} 个用例 · <code>{item.id}</code>
              </div>
              {item.readme ? <div className="example-item__readme">{item.readme}</div> : null}
            </div>
            <button
              type="button"
              className="btn btn--primary btn--small"
              onClick={() => onImport(item)}
              disabled={importingId !== null}
            >
              {importingId === item.id ? '导入中…' : '导入'}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}

export default function ProjectBar({ projects, currentId, loading, onSelect, onRefresh }: Props) {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [examples, setExamples] = useState<ExampleItem[]>([])
  const [examplesLoading, setExamplesLoading] = useState(false)
  const [examplesError, setExamplesError] = useState('')
  const [importingId, setImportingId] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(''), 4000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const current = projects.find((p) => p.id === currentId) ?? null

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (project: Project) => {
    setEditing(project)
    setFormOpen(true)
  }

  const doDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    setError('')
    try {
      await api.deleteProject(pendingDelete.id)
      const remained = projects.filter((p) => p.id !== pendingDelete.id)
      setPendingDelete(null)
      onRefresh(remained[0]?.id)
      setToast('项目已删除')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setDeleting(false)
    }
  }

  const openExamples = async () => {
    setExamplesOpen(true)
    setExamplesLoading(true)
    setExamplesError('')
    try {
      setExamples(await api.listExamples())
    } catch (err) {
      setExamplesError(errorMessage(err))
    } finally {
      setExamplesLoading(false)
    }
  }

  const doImportExample = async (item: ExampleItem) => {
    setImportingId(item.id)
    setExamplesError('')
    try {
      const result = await api.importExample(item.id)
      setExamplesOpen(false)
      onRefresh(result.project.id)
      setToast(`已导入示例「${result.project.name}」，共 ${result.caseCount} 个用例`)
    } catch (err) {
      setExamplesError(errorMessage(err))
    } finally {
      setImportingId(null)
    }
  }

  const doImportJson = async (file: File) => {
    setError('')
    try {
      const text = await file.text()
      let bundle: { project: unknown; cases: unknown[] }
      try {
        bundle = JSON.parse(text)
      } catch {
        throw new Error('文件不是合法 JSON，无法解析')
      }
      if (!bundle?.project) throw new Error('JSON 缺少 project 字段（请使用本平台导出的文件）')
      const result = await api.importBundle({ project: bundle.project, cases: bundle.cases ?? [] })
      onRefresh(result.project.id)
      setToast(`已导入项目「${result.project.name}」，共 ${result.caseCount} 个用例`)
    } catch (err) {
      setError(`导入失败：${errorMessage(err)}`)
    }
  }

  const doExport = async () => {
    if (!current) return
    setError('')
    try {
      await api.downloadExport(current.id, `${current.name}.json`)
      setToast('已导出到浏览器下载目录')
    } catch (err) {
      setError(`导出失败：${errorMessage(err)}`)
    }
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__head">
        <span className="sidebar__title">项目</span>
        <button type="button" className="btn btn--small btn--primary" onClick={openCreate}>
          + 新建
        </button>
      </div>

      {error ? (
        <div className="sidebar__notice">
          <Notice tone="error" onClose={() => setError('')}>
            {error}
          </Notice>
        </div>
      ) : null}
      {toast ? (
        <div className="sidebar__notice">
          <Notice tone="success" onClose={() => setToast('')}>
            {toast}
          </Notice>
        </div>
      ) : null}

      <div className="sidebar__list">
        {loading ? <div className="muted sidebar__pad">正在加载项目…</div> : null}
        {!loading && projects.length === 0 ? (
          <div className="empty empty--sidebar">
            <p className="empty__title">还没有项目</p>
            <p className="empty__text">点「导入示例」一键体验，或「新建」创建第一个项目。</p>
          </div>
        ) : null}
        {projects.map((project) => (
          <div
            key={project.id}
            className={`proj-item${project.id === currentId ? ' proj-item--active' : ''}`}
            onClick={() => onSelect(project.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelect(project.id)
            }}
          >
            <div className="proj-item__body">
              <div className="proj-item__name" title={project.name}>
                {project.name}
              </div>
              <div className="proj-item__meta">
                {project.caseCount ?? 0} 个用例
                {project.baseUrl ? <span className="proj-item__url" title={project.baseUrl}> · {project.baseUrl}</span> : null}
              </div>
            </div>
            <div className="proj-item__actions">
              <button
                type="button"
                className="icon-btn"
                title="编辑项目"
                aria-label="编辑项目"
                onClick={(event) => {
                  event.stopPropagation()
                  openEdit(project)
                }}
              >
                ✎
              </button>
              <button
                type="button"
                className="icon-btn icon-btn--danger"
                title="删除项目"
                aria-label="删除项目"
                onClick={(event) => {
                  event.stopPropagation()
                  setPendingDelete(project)
                }}
              >
                🗑
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <button type="button" className="btn btn--small" onClick={openExamples}>
          导入示例
        </button>
        <button type="button" className="btn btn--small" onClick={() => fileInput.current?.click()}>
          导入 JSON
        </button>
        <button type="button" className="btn btn--small" onClick={doExport} disabled={!current}>
          导出 JSON
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void doImportJson(file)
          }}
        />
      </div>

      {formOpen ? (
        <ProjectFormModal
          project={editing}
          onClose={() => setFormOpen(false)}
          onSaved={(project, created) => {
            setFormOpen(false)
            onRefresh(project.id)
            setToast(created ? `项目「${project.name}」已创建` : `项目「${project.name}」已保存`)
          }}
        />
      ) : null}

      {examplesOpen ? (
        <ExamplesModal
          examples={examples}
          loading={examplesLoading}
          error={examplesError}
          importingId={importingId}
          onImport={(item) => void doImportExample(item)}
          onClose={() => setExamplesOpen(false)}
        />
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="删除项目"
          busy={deleting}
          message={
            <>
              确定删除项目「<b>{pendingDelete.name}</b>」吗？该项目下的{' '}
              <b>{pendingDelete.caseCount ?? 0}</b> 个用例会被一并删除，操作不可撤销。
            </>
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void doDelete()}
        />
      ) : null}
    </aside>
  )
}
