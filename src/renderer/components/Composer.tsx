import { memo, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ClipboardEvent } from 'react'
import type { PickedFile } from '@shared/types'
import { DRAFT_ID, store, type SendOutcome } from '../store'
import { formatSize } from '../util'

interface Props {
  sessionId: string
  running: boolean
  queue: string[]
  disabled: boolean
  needsModel?: boolean
  model: string
  /** 当前模型是否接受图片输入；不支持时图片附件会被拦下并说明原因 */
  supportsImages: boolean
  onSend: (text: string, files: PickedFile[]) => Promise<SendOutcome | null>
  onAbort: () => void
}

const MAX_PENDING = 8
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024

/** 输入中的 @ 引用补全状态：start/end 是 @token 在文本里的区间 */
interface AtMenu {
  query: string
  start: number
  end: number
  items: string[]
  active: number
}

/** 消息里出现的 @ 引用（发送时内联成文本附件） */
const MENTION_RE = /(?:^|\s)@([^\s@]+)/g

export const Composer = memo(function Composer({
  sessionId,
  running,
  queue,
  disabled,
  needsModel,
  model,
  supportsImages,
  onSend,
  onAbort
}: Props): JSX.Element {
  const [value, setValue] = useState('')
  const [pending, setPending] = useState<PickedFile[]>([])
  const [staging, setStaging] = useState(false)
  const [sending, setSending] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [atMenu, setAtMenu] = useState<AtMenu | null>(null)
  const atSeq = useRef(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const drafts = useRef(new Map<string, { value: string; pending: PickedFile[] }>())
  const previousSession = useRef(sessionId)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  useEffect(() => {
    if (previousSession.current === sessionId) return
    const previous = previousSession.current
    drafts.current.set(previous, { value, pending })
    previousSession.current = sessionId
    if (previous === DRAFT_ID && sending) {
      drafts.current.set(sessionId, { value, pending })
      return
    }
    const next = drafts.current.get(sessionId)
    setValue(next?.value ?? '')
    setPending(next?.pending ?? [])
    setStaging(false)
    setSending(false)
    setDragOver(false)
    setAtMenu(null)
  }, [sessionId])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const looksLikeImage = (f: { mime: string; name: string }): boolean =>
    f.mime.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.name)

  const addFiles = (files: PickedFile[]): void => {
    const accepted: PickedFile[] = []
    for (const f of files) {
      if (looksLikeImage(f) && !supportsImages) {
        store.notify('warn', `当前模型（${model || '未选择'}）不支持图片输入，「${f.name}」已跳过`)
        continue
      }
      accepted.push(f)
    }
    if (!accepted.length) return
    setPending((prev) => {
      const room = MAX_PENDING - prev.length
      if (accepted.length > room) {
        store.notify('warn', `一条消息最多带 ${MAX_PENDING} 个附件`)
        return [...prev, ...accepted.slice(0, Math.max(room, 0))]
      }
      return [...prev, ...accepted]
    })
  }

  const pick = async (): Promise<void> => {
    const targetSession = sessionId
    try {
      const picked = await window.pi.pickAttachments()
      if (picked?.length && sessionRef.current === targetSession) addFiles(picked)
    } catch (err) {
      store.notify('error', `添加附件失败：${(err as Error).message}`)
    }
  }

  const ingestFileList = async (list: FileList | File[]): Promise<void> => {
    const files = [...list]
    if (!files.length) return
    const room = MAX_PENDING - pending.length
    if (room <= 0) {
      store.notify('warn', `一条消息最多带 ${MAX_PENDING} 个附件`)
      return
    }
    if (files.length > room) store.notify('warn', `一条消息最多带 ${MAX_PENDING} 个附件，超出部分已跳过`)
    const targetSession = sessionId
    setStaging(true)
    try {
      const picked: PickedFile[] = []
      for (const f of files.slice(0, room)) {
        const name = f.name || 'clipboard.png'
        const image = looksLikeImage({ mime: f.type, name })
        if (image && !supportsImages) {
          store.notify('warn', `当前模型（${model || '未选择'}）不支持图片输入，「${name}」已跳过`)
          continue
        }
        const limit = image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES
        if (f.size === 0 || f.size > limit) {
          store.notify('warn', f.size === 0 ? `「${name}」是空文件` : `「${name}」超过附件大小上限，已跳过`)
          continue
        }
        const bytes = new Uint8Array(await f.arrayBuffer())
        if (sessionRef.current !== targetSession) return
        picked.push({ name, mime: f.type, bytes })
      }
      addFiles(picked)
    } catch (err) {
      store.notify('error', `读取附件失败：${(err as Error).message}`)
    } finally {
      if (sessionRef.current === targetSession) setStaging(false)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (!files.length) return
    e.preventDefault()
    void ingestFileList(files)
  }

  /* ---------------- @ 文件引用补全 ---------------- */

  const onValueChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const v = e.target.value
    setValue(v)
    const caret = e.target.selectionStart ?? v.length
    const m = /(?:^|\s)@([\w./\\-]*)$/.exec(v.slice(0, caret))
    if (!m) {
      setAtMenu(null)
      return
    }
    const query = m[1]
    const start = caret - query.length - 1
    setAtMenu((prev) =>
      prev ? { ...prev, query, start, end: caret } : { query, start, end: caret, items: [], active: 0 }
    )
    if (query.trim().length < 1) return // 光敲一个 @ 不搜，等输入内容
    atSeq.current++
    const seq = atSeq.current
    window.setTimeout(() => {
      void store.searchFiles(sessionId, query).then((items) => {
        if (atSeq.current !== seq) return
        setAtMenu((prev) =>
          prev && prev.query === query
            ? { ...prev, items: items.slice(0, 8), active: Math.min(prev.active, Math.max(items.length - 1, 0)) }
            : prev
        )
      })
    }, 120)
  }

  const pickAt = (item: string): void => {
    if (!atMenu) return
    const insert = `@${item} `
    const next = value.slice(0, atMenu.start) + insert + value.slice(atMenu.end)
    setValue(next)
    setAtMenu(null)
    const pos = atMenu.start + insert.length
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  /** 发送前把 @引用 的文件内联成文本附件（草稿会话 / 读不到的保持原样，只提示一次） */
  const resolveMentions = async (text: string): Promise<PickedFile[]> => {
    if (sessionId === DRAFT_ID || !text.includes('@')) return []
    const paths = [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]))]
    if (!paths.length) return []
    const room = MAX_PENDING - pending.length
    if (room <= 0) return []
    const out: PickedFile[] = []
    for (const p of paths.slice(0, room)) {
      const f = await store.readFile(sessionId, p)
      if (!f) {
        store.notify('warn', `「@${p}」不在工作目录内（或是二进制 / 超过 256KB），已按普通文字发送`)
        continue
      }
      out.push({ name: f.name, mime: 'text/plain', bytes: new TextEncoder().encode(f.text) })
    }
    return out
  }

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) void ingestFileList(e.dataTransfer.files)
  }

  const submit = (): void => {
    const text = value.trim()
    if ((!text && !pending.length) || disabled || staging || sending) return
    const originalValue = value
    const files = pending
    const targetSession = sessionId
    setSending(true)
    void resolveMentions(text)
      .then((extra) => onSend(text, [...files, ...extra]))
      .then((outcome) => {
        if (!outcome) return
        if (outcome.ok) {
          drafts.current.delete(targetSession)
          drafts.current.delete(outcome.sessionId)
        }
        if (sessionRef.current !== outcome.sessionId) return
        setSending(false)
        if (!outcome.ok) return
        setValue((current) => (current === originalValue ? '' : current))
        setPending((current) => (current === files ? [] : current))
      })
      .catch((err) => store.notify('error', `发送失败：${(err as Error).message}`))
      .finally(() => {
        if (sessionRef.current === targetSession) setSending(false)
      })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // @ 补全菜单开着时：方向键移动、Enter/Tab 选中、Esc 关闭（此时 Enter 不发送）
    if (atMenu && atMenu.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setAtMenu((prev) =>
          prev ? { ...prev, active: (prev.active + delta + prev.items.length) % prev.items.length } : prev
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickAt(atMenu.items[atMenu.active])
        return
      }
    }
    if (e.key === 'Escape') {
      if (atMenu) {
        e.preventDefault()
        setAtMenu(null)
        return
      }
      if (running) {
        e.preventDefault()
        onAbort()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div
      className={`composer ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      {queue.length > 0 && (
        <div className="queue-row">
          <span className="queue-label">排队 {queue.length}</span>
          {queue.map((q, i) => (
            <span className="queue-chip" key={i} title={q}>
              {q.length > 44 ? `${q.slice(0, 44)}…` : q}
            </span>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="attach-row">
          {pending.map((f, i) => (
            <span className="attach-chip" key={`${f.name}-${i}`} title={`${f.name} · ${formatSize(f.bytes.byteLength)}`}>
              <span className={`attach-icon ${looksLikeImage(f) ? 'img' : 'txt'}`}>
                {looksLikeImage(f) ? (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <circle cx="6" cy="7" r="1.2" fill="currentColor" stroke="none" />
                    <path d="M3 12l3.5-3.5 2.5 2.5 2-2L14 12" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <path d="M4 2h5l3 3v9H4z" strokeLinejoin="round" />
                    <path d="M9 2v3h3" />
                  </svg>
                )}
              </span>
              <span className="attach-name">{f.name}</span>
              <span className="attach-size">{formatSize(f.bytes.byteLength)}</span>
              <button
                type="button"
                className="attach-remove"
                title="移除附件"
                onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={`composer-box ${running ? 'running' : ''} ${dragOver ? 'drop' : ''}`}>
        <button
          className="btn-attach"
          type="button"
          title="添加附件（图片或文本文件，也可直接粘贴 / 拖入）"
          onClick={() => void pick()}
          disabled={disabled || staging || sending}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M11.5 4.5 5.9 10.1a1.8 1.8 0 0 0 2.5 2.5l5.4-5.4a3 3 0 0 0-4.3-4.3L4 8.4a4.2 4.2 0 0 0 6 6l4.8-4.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder={
            needsModel
              ? '请先在顶栏选择一个模型'
              : running
                ? '继续补充要求，会追加到当前任务…'
                : '描述你要做的改动，Enter 发送；@ 引用文件，可粘贴或拖入图片'
          }
          onChange={onValueChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onScroll={() => setAtMenu(null)}
          disabled={disabled}
          spellCheck={false}
        />
        {atMenu && atMenu.items.length > 0 && (
          <div className="at-pop">
            {atMenu.items.map((item, i) => {
              const slash = item.lastIndexOf('/')
              const dir = slash >= 0 ? item.slice(0, slash) : ''
              const name = slash >= 0 ? item.slice(slash + 1) : item
              return (
                <button
                  key={item}
                  type="button"
                  className={`at-item ${i === atMenu.active ? 'active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickAt(item)}
                  title={item}
                >
                  <span className="at-name">{name}</span>
                  {dir && <span className="at-dir">{dir}/</span>}
                </button>
              )
            })}
          </div>
        )}
        <div className="composer-actions">
          {running && (
            <button className="btn-stop" type="button" onClick={onAbort} title="停止当前任务（Esc）">
              <span className="stop-square" />
              停止
            </button>
          )}
          <button
            className={`btn-send ${running ? 'queue' : ''}`}
            type="button"
            onClick={submit}
            disabled={(!value.trim() && !pending.length) || disabled || staging || sending}
          >
            {staging || sending ? '…' : running ? '追加' : '发送'}
          </button>
        </div>
      </div>

      <div className="composer-hint">
        <span>
          <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行
          {running ? ' · ' : ''}
          {running ? (
            <>
              <kbd>Esc</kbd> 停止
            </>
          ) : null}
        </span>
        <span className="hint-model">{model}</span>
      </div>
    </div>
  )
})
