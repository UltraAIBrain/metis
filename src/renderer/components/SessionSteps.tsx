import { memo, useEffect, useRef, useState } from 'react'
import { store, useSlice } from '../store'

/**
 * 顶栏的会话级单轮步数上限切换器。
 * 长任务（大范围重构、多轮排错）往往一轮就要几十步，40 步的全局默认容易在中途硬停；
 * 这里只写当前会话的 meta，没设过就跟随设置里的默认值。
 * 样式复用 SessionThinking 的 chip / menu 类，不额外引入样式。
 */
const PRESETS: { value: number; label: string; hint: string }[] = [
  { value: 20, label: '20 步', hint: '小改动，快收敛' },
  { value: 40, label: '40 步', hint: '默认，常规任务' },
  { value: 80, label: '80 步', hint: '批量改造、多轮排错' },
  { value: 150, label: '150 步', hint: '大范围重构' },
  { value: 200, label: '200 步', hint: '上限，尽量不停' }
]

export const SessionSteps = memo(function SessionSteps(): JSX.Element {
  const sessionSteps = useSlice((s) => s.session?.maxSteps)
  const defaultSteps = useSlice((s) => s.config.maxSteps)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const current = sessionSteps ?? defaultSteps ?? 40
  const overridden = typeof sessionSteps === 'number'

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

  const pick = (value: number | undefined): void => {
    void store.setSessionSteps(value)
    setOpen(false)
  }

  return (
    <div className="model-menu-wrap" ref={wrapRef}>
      <button
        className={`model-chip ${open ? 'open' : ''}`}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="单轮步数上限：一轮任务最多几步工具往返，只影响本会话"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="chip-provider">步数</span>
        <span className="chip-sep">·</span>
        <span className="chip-model">{current}</span>
        <svg className="chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M5 6l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="think-menu">
          {PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`think-option ${current === p.value ? 'current' : ''}`}
              onClick={() => pick(p.value)}
            >
              <span>
                <span className="think-label">{p.label}</span>
                <span className="think-hint">{p.hint}</span>
              </span>
              {current === p.value && <span className="check">✓</span>}
            </button>
          ))}

          {overridden && (
            <button type="button" className="menu-link think-reset" onClick={() => pick(undefined)}>
              跟随默认（{defaultSteps ?? 40} 步）
            </button>
          )}

          <div className="think-note">
            一轮任务最多几步工具往返，只对本会话生效。达到上限会自动停下，
            回一句「继续」即可接着做；子任务另有 24 步上限。
          </div>
        </div>
      )}
    </div>
  )
})
