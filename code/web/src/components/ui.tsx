/**
 * 通用小部件：状态徽标、类型徽标、错误提示条、模态框、键值对编辑器。
 */
import { useState, type ReactNode } from 'react'
import { statusLabel, statusTone, caseTypeLabel } from '../format'
import type { LogLevel } from '../types'

/** 状态徽标：通过=绿、失败=红、异常=橙、跳过=灰、执行中=蓝（呼吸动画）。 */
export function StatusBadge({ status, text }: { status: string | undefined | null; text?: string }) {
  const tone = statusTone(status)
  return <span className={`badge badge--${tone}`}>{text ?? statusLabel(status)}</span>
}

/** 用例类型徽标：API / Web。 */
export function TypeBadge({ type }: { type: string | undefined | null }) {
  return <span className={`badge badge--type badge--type-${type ?? 'unknown'}`}>{caseTypeLabel(type)}</span>
}

/** 标签小片。 */
export function TagChips({ tags }: { tags: string[] | undefined }) {
  if (!tags?.length) return null
  return (
    <span className="tags">
      {tags.map((tag) => (
        <span className="tag" key={tag}>
          {tag}
        </span>
      ))}
    </span>
  )
}

/** 提示条：错误（红）/ 警告（橙）/ 成功（绿）/ 信息（蓝）。 */
export function Notice({
  tone = 'info',
  children,
  onClose,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success'
  children: ReactNode
  onClose?: () => void
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <span className="notice__body">{children}</span>
      {onClose ? (
        <button type="button" className="notice__close" onClick={onClose} aria-label="关闭提示">
          ×
        </button>
      ) : null}
    </div>
  )
}

/** 模态框（无第三方依赖，ESC / 遮罩点击关闭）。 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  return (
    <div
      className="modal-mask"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__head">
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

/** 二次确认对话框。 */
export function ConfirmDialog({
  title,
  message,
  confirmText = '确认删除',
  onConfirm,
  onCancel,
  busy,
}: {
  title: string
  message: ReactNode
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
            {busy ? '处理中…' : confirmText}
          </button>
        </>
      }
    >
      <div className="confirm-message">{message}</div>
    </Modal>
  )
}

/** 日志滚动区（等宽字体）。 */
export function LogLine({ level, time, message }: { level?: LogLevel; time?: number; message: string }) {
  return (
    <div className={`log-line log-line--${level ?? 'info'}`}>
      {time ? <span className="log-line__time">{new Date(time).toLocaleTimeString('zh-CN', { hour12: false })}</span> : null}
      <span className="log-line__text">{message}</span>
    </div>
  )
}

type KeyValueEditorProps = {
  value: Record<string, string> | undefined
  onChange: (next: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  addText?: string
  emptyText?: string
}

/** 键值对编辑器：用于变量 / 请求头 / 查询参数。 */
export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = '名称',
  valuePlaceholder = '值',
  addText = '添加一行',
  emptyText = '暂无内容',
}: KeyValueEditorProps) {
  const entries = Object.entries(value ?? {})
  const [draftKey, setDraftKey] = useState('')
  const [draftValue, setDraftValue] = useState('')

  const rename = (oldKey: string, nextKey: string) => {
    const next: Record<string, string> = {}
    for (const [k, v] of entries) {
      if (k === oldKey) {
        if (nextKey.trim()) next[nextKey] = v
      } else {
        next[k] = v
      }
    }
    onChange(next)
  }

  const setValue = (key: string, next: string) => onChange({ ...(value ?? {}), [key]: next })

  const remove = (key: string) => {
    const next = { ...(value ?? {}) }
    delete next[key]
    onChange(next)
  }

  const add = () => {
    const key = draftKey.trim()
    if (!key) return
    onChange({ ...(value ?? {}), [key]: draftValue })
    setDraftKey('')
    setDraftValue('')
  }

  return (
    <div className="kv">
      {entries.length === 0 ? <div className="kv__empty">{emptyText}</div> : null}
      {entries.map(([key, val]) => (
        <div className="kv__row" key={key}>
          <input
            className="input input--mono kv__key"
            value={key}
            onChange={(event) => rename(key, event.target.value)}
            placeholder={keyPlaceholder}
          />
          <input
            className="input input--mono"
            value={val}
            onChange={(event) => setValue(key, event.target.value)}
            placeholder={valuePlaceholder}
          />
          <button type="button" className="icon-btn" onClick={() => remove(key)} title="删除该行" aria-label="删除该行">
            ×
          </button>
        </div>
      ))}
      <div className="kv__row kv__row--add">
        <input
          className="input input--mono kv__key"
          value={draftKey}
          onChange={(event) => setDraftKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
          placeholder={keyPlaceholder}
        />
        <input
          className="input input--mono"
          value={draftValue}
          onChange={(event) => setDraftValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
          placeholder={valuePlaceholder}
        />
        <button type="button" className="btn btn--small" onClick={add} disabled={!draftKey.trim()}>
          {addText}
        </button>
      </div>
    </div>
  )
}

/** 截图缩略图：点击放大。 */
export function ScreenshotThumb({
  src,
  alt,
  onZoom,
}: {
  src: string
  alt: string
  onZoom: (src: string, alt: string) => void
}) {
  return (
    <button type="button" className="shot" onClick={() => onZoom(src, alt)} title="点击放大查看">
      <img src={src} alt={alt} loading="lazy" />
    </button>
  )
}

/** 图片放大查看层。 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label={alt}>
      <img src={src} alt={alt} />
      <div className="lightbox__hint">点击任意位置关闭</div>
    </div>
  )
}
