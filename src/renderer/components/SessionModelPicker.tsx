import { memo, useEffect, useRef, useState } from 'react'
import type { PublicProfile } from '@shared/types'
import { profileShortName } from '@shared/providers'
import { modelsOf, sessionModelOf, sessionProfileOf, store, useSlice } from '../store'

/**
 * 顶栏的会话级模型切换器。
 * 这里的选择只写进当前会话的 meta，不影响其它会话，也不改全局默认。
 */
export const SessionModelPicker = memo(function SessionModelPicker(): JSX.Element {
  const session = useSlice((s) => s.session)
  const config = useSlice((s) => s.config)
  const runningIds = useSlice((s) => s.runningIds)
  const modelCache = useSlice((s) => s.modelCache)
  const [open, setOpen] = useState(false)
  const [browsing, setBrowsing] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  const bound = sessionProfileOf({ session, config })
  const current = sessionModelOf({ session, config })
  const profiles = config.profiles
  const viewProfile = profiles.find((p) => p.id === (browsing ?? bound?.id)) ?? bound
  const models = modelsOf({ modelCache }, viewProfile)
  const running = Boolean(session && runningIds.includes(session.id))

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

  const load = async (profile: PublicProfile, silent = false): Promise<void> => {
    const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(profile.baseUrl)
    if (!profile.hasKey && !local) {
      if (!silent) setError('该提供商还没配置 API Key，可在设置里补上')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await store.loadModels(profile)
      if (!res.ok) setError(res.error.message)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    setBrowsing(null)
    setError(null)
    setManual('')
    if (next && bound && modelsOf({ modelCache }, bound).length === 0) void load(bound, true)
  }

  const bind = async (profile: PublicProfile, model: string): Promise<void> => {
    if (!model.trim()) return
    const wasRunning = running
    const ok = await store.setSessionModel(profile.id, model)
    if (!ok) return
    setOpen(false)
    if (wasRunning) store.notify('info', '已切换，下一条消息生效')
  }

  if (!bound) {
    return (
      <button className="model-chip" type="button" onClick={() => store.openSettings()}>
        未配置模型
      </button>
    )
  }

  return (
    <div className="model-menu-wrap" ref={wrapRef}>
      <button
        className={`model-chip ${open ? 'open' : ''} ${current ? '' : 'warn'}`}
        type="button"
        onClick={toggle}
        title={current ? '切换本会话使用的提供商与模型' : '还没有选择模型，点这里选一个'}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="chip-provider">{profileShortName(bound)}</span>
        <span className="chip-sep">·</span>
        <span className={`chip-model ${current ? '' : 'empty'}`}>{current || '选择模型'}</span>
        <svg className="chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="M5 6l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="model-menu">
          <div className="menu-pane providers">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`provider-row ${p.id === viewProfile?.id ? 'active' : ''}`}
                onClick={() => {
                  setBrowsing(p.id)
                  setError(null)
                  // 用户主动切换：失败要给出原因；打开面板时的自动预取则保持静默
                  if (modelsOf({ modelCache }, p).length === 0) void load(p)
                }}
                title={`${p.label} · ${p.baseUrl}`}
              >
                <span className="provider-name">{profileShortName(p)}</span>
                {(p.hasKey || p.id === bound.id) && <span className="provider-dot" />}
              </button>
            ))}
            {!profiles.length && <div className="menu-note">还没有提供商</div>}
          </div>

          <div className="menu-pane models">
            <div className="menu-title">
              {viewProfile?.label ?? '模型'}
              {models.length > 0 && <span className="menu-count">{models.length}</span>}
            </div>

            <div className="menu-list">
              {loading && <div className="menu-note">读取中…</div>}
              {!loading &&
                models.map((m) => {
                  const isCurrent = viewProfile?.id === bound.id && m.id === current
                  return (
                    <button
                      key={m.id}
                      type="button"
                      className={`model-option ${isCurrent ? 'current' : ''}`}
                      onClick={() => viewProfile && void bind(viewProfile, m.id)}
                    >
                      <span className="model-option-id">{m.id}</span>
                      {m.label && <span className="model-option-hint">{m.label}</span>}
                      {isCurrent && <span className="check">✓</span>}
                    </button>
                  )
                })}
              {!loading && !models.length && <div className="menu-note">还没有模型列表，可点下方「读取列表」</div>}
            </div>

            <div className="menu-foot">
              {error && <div className="menu-err">{error}</div>}
              <input
                className="menu-input"
                value={manual}
                placeholder="或直接输入模型名，回车绑定"
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && viewProfile) {
                    e.preventDefault()
                    void bind(viewProfile, manual)
                  }
                }}
                spellCheck={false}
              />
              <div className="menu-foot-row">
                <button type="button" className="menu-link" onClick={() => viewProfile && void load(viewProfile)}>
                  {loading ? '读取中…' : '读取列表'}
                </button>
                <button
                  type="button"
                  className="menu-link"
                  onClick={() => {
                    setOpen(false)
                    store.openSettings()
                  }}
                >
                  管理提供商
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
