import { memo, useEffect, useRef, useState } from 'react'
import type { ThinkingEffort } from '@shared/types'
import { store, useSlice } from '../store'

const LEVELS: { id: ThinkingEffort; label: string; hint: string }[] = [
  { id: 'low', label: '低', hint: '快，少花 token' },
  { id: 'high', label: '高', hint: '速度与深度平衡' },
  { id: 'max', label: '极致', hint: '最深推理，最慢' }
]

const LABEL: Record<ThinkingEffort, string> = { low: '低', high: '高', max: '极致' }

/**
 * 顶栏的会话级思考强度切换器。
 * 只写当前会话的 meta；没设过就跟随设置里的默认值。
 */
export const SessionThinking = memo(function SessionThinking(): JSX.Element {
  const sessionThinking = useSlice((s) => s.session?.thinking)
  const defaultThinking = useSlice((s) => s.config.thinking)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const current = sessionThinking ?? defaultThinking ?? 'high'
  const overridden = Boolean(sessionThinking)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (id: ThinkingEffort | undefined): void => {
    void store.setSessionThinking(id)
    setOpen(false)
  }

  return (
    <div className="model-menu-wrap" ref={wrapRef}>
      <button
        className={`model-chip ${open ? 'open' : ''}`}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="思考强度：只影响本会话之后的请求"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="chip-provider">思考</span>
        <span className="chip-sep">·</span>
        <span className="chip-model">{LABEL[current]}</span>
        <svg className="chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M5 6l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="think-menu">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`think-option ${current === l.id ? 'current' : ''}`}
              onClick={() => pick(l.id)}
            >
              <span>
                <span className="think-label">{l.label}</span>
                <span className="think-hint">{l.hint}</span>
              </span>
              {current === l.id && <span className="check">✓</span>}
            </button>
          ))}

          {overridden && (
            <button type="button" className="menu-link think-reset" onClick={() => pick(undefined)}>
              跟随默认（{LABEL[defaultThinking ?? 'high']}）
            </button>
          )}

          <div className="think-note">
            只对本会话生效，不改全局默认。模型不支持该参数时会自动忽略。
          </div>
        </div>
      )}
    </div>
  )
})
