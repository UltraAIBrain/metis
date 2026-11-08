import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { ModelOption } from '@shared/types'
import { formatTokens } from '@shared/model-catalog'

/**
 * 模型选择器：可搜索、可刷新，也可直接手填（火山方舟这类需要接入点 ID）。
 */
export function ModelPicker({
  value,
  options,
  loading,
  onChange,
  onRefresh
}: {
  value: string
  options: ModelOption[]
  loading: boolean
  onChange: (id: string) => void
  onRefresh: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  useEffect(() => {
    if (!open) return
    // 选择器就在面板底部：把滚动容器拉到底，避免展开的列表被裁掉
    const scroller = wrapRef.current?.closest('.settings-pane') as HTMLElement | null
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((m) => m.id.toLowerCase().includes(q) || (m.label ?? '').toLowerCase().includes(q))
  }, [options, query])

  const pick = (id: string): void => {
    const v = id.trim()
    if (!v) return
    onChange(v)
    setOpen(false)
    setQuery('')
  }

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[cursor] as HTMLElement | undefined
    // 列表可滚动（max-height 176px）：键盘移动光标时让选中项保持可见
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [cursor, open])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = filtered[cursor]
      pick(hit ? hit.id : query)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div className="model-picker" ref={wrapRef}>
      <div className="model-row">
        <button
          type="button"
          className={`model-trigger ${open ? 'open' : ''}`}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className={`model-value ${value ? '' : 'empty'}`}>{value || '选择或输入模型名'}</span>
          {options.length > 0 && <span className="model-count">{options.length}</span>}
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M5 6l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="btn-ghost small"
          onClick={onRefresh}
          disabled={loading}
          title="从服务商接口重新读取模型列表"
        >
          {loading ? '读取中…' : '读取'}
        </button>
      </div>

      {open && (
        <div className="model-panel">
          <input
            ref={inputRef}
            className="model-search"
            value={query}
            placeholder={options.length ? `搜索 ${options.length} 个模型` : '列表为空，可直接输入后回车'}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />
          <div className="model-list" ref={listRef}>
            {filtered.map((m, i) => (
              <button
                type="button"
                key={m.id}
                className={`model-item ${i === cursor ? 'cursor' : ''} ${m.id === value ? 'active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => pick(m.id)}
              >
                <span className="model-item-id">{m.id}</span>
                {(m.label || m.hint) && <span className="model-item-hint">{m.label ?? m.hint}</span>}
                {m.contextWindow ? <span className="model-item-ctx">{formatTokens(m.contextWindow)}</span> : null}
              </button>
            ))}
            {!filtered.length && <div className="model-empty">{options.length ? '没有匹配的模型' : '还没有模型列表'}</div>}
          </div>
          {query.trim() && !filtered.some((m) => m.id === query.trim()) && (
            <button type="button" className="model-manual" onClick={() => pick(query)}>
              使用手动输入：<code>{query.trim()}</code>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
