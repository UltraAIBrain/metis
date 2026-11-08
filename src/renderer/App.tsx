import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { PickedFile } from '@shared/types'
import {
  DRAFT_ID,
  isRunning,
  modelSupportsImagesOf,
  sessionModelOf,
  store,
  useSlice
} from './store'
import { Sidebar } from './components/Sidebar'
import { MessageList } from './components/MessageList'
import { Composer } from './components/Composer'
import { StatusBar } from './components/StatusBar'
import { SettingsDialog } from './components/SettingsDialog'
import { Toasts } from './components/Toasts'
import { SessionModelPicker } from './components/SessionModelPicker'
import { SessionDir } from './components/SessionDir'
import { SessionThinking } from './components/SessionThinking'
import { StartScreen } from './components/StartScreen'
import { SidePanel } from './components/SidePanel'
import { AskDialog } from './components/AskDialog'

function Splash({ text }: { text: string }): JSX.Element {
  return (
    <div className="splash">
      <div className="splash-mark">π</div>
      <div className="splash-text">{text}</div>
    </div>
  )
}

export function App(): JSX.Element {
  const ready = useSlice((s) => s.ready)
  const fatal = useSlice((s) => s.fatal)
  const session = useSlice((s) => s.session)
  const config = useSlice((s) => s.config)
  const runningIds = useSlice((s) => s.runningIds)
  const modelCache = useSlice((s) => s.modelCache)
  const panelOpen = useSlice((s) => s.panelOpen)
  const panelFull = useSlice((s) => s.panelFull)
  const notices = useSlice((s) => s.notices)
  const settingsOpen = useSlice((s) => s.settingsOpen)
  const sessionId = session?.id
  const queue = useSlice((s) => (sessionId ? s.queue[sessionId] ?? EMPTY_QUEUE : EMPTY_QUEUE))

  /** 侧栏宽度（180–480px），记忆在 localStorage */
  const [sidebarW, setSidebarW] = useState<number>(() => {
    const saved = Number(localStorage.getItem('pi.sidebarWidth'))
    return Number.isFinite(saved) && saved >= 180 && saved <= 480 ? saved : 264
  })
  /** 面板宽度（220–640px）；null = 未拖过，用 CSS 默认（含媒体查询） */
  const [panelW, setPanelW] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem('pi.panelWidth'))
    return Number.isFinite(saved) && saved >= 220 && saved <= 640 ? saved : null
  })
  const appRef = useRef<HTMLDivElement>(null)

  /**
   * 拖拽分割线：拖动过程直接改 CSS 变量（零重渲染），松手才落状态与 localStorage。
   * 拖拽期间盖一层全屏透明屏障：光标经过面板里的 <webview>（浏览器）时事件会被原生层
   * 吞掉（mousemove 冻结、mouseup 丢失 → 拖拽"粘住"），屏障保证事件全程走 HTML 层；
   * 窗口失焦（Alt+Tab、鼠标拖出窗外松手）按最后宽度提交，杜绝拖拽卡死。
   */
  const startDrag =
    (opts: { cssVar: string; storageKey: string; min: number; max: number; fromLeft: boolean; fallback: number }) =>
    (e: React.MouseEvent): void => {
      e.preventDefault()
      const { cssVar, storageKey, min, max, fromLeft, fallback } = opts
      const clamp = (px: number): number => Math.min(max, Math.max(min, px))
      const startX = e.clientX
      /* 侧栏：起点宽 = 鼠标 x（分割线在窗口左缘起算）；面板：起点宽 = 当前面板实测宽。
         拖动中的宽度 = 起点宽 + (startX - 当前 x)，向左拖加宽、向右拖收窄 */
      const panelEl = document.querySelector('.side-panel') as HTMLElement | null
      const startW = fromLeft ? startX : panelEl ? panelEl.getBoundingClientRect().width : fallback
      let last = clamp(startW)
      const apply = (px: number): void => {
        last = px
        appRef.current?.style.setProperty(cssVar, `${px}px`)
      }

      const shield = document.createElement('div')
      shield.className = 'pane-drag-shield'
      document.body.appendChild(shield)
      document.body.classList.add('pane-resizing')

      const finish = (raw: number): void => {
        shield.remove()
        document.body.classList.remove('pane-resizing')
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('blur', onBlur)
        const w = clamp(raw)
        apply(w)
        localStorage.setItem(storageKey, String(w))
        if (cssVar === '--sidebar-w') setSidebarW(w)
        else setPanelW(w)
      }
      const widthAt = (ev: MouseEvent): number => (fromLeft ? ev.clientX : startW + startX - ev.clientX)
      const onMove = (ev: MouseEvent): void => apply(clamp(widthAt(ev)))
      const onUp = (ev: MouseEvent): void => finish(widthAt(ev))
      const onBlur = (): void => finish(last)
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      window.addEventListener('blur', onBlur)
    }

  const startSidebarDrag = useCallback(
    startDrag({ cssVar: '--sidebar-w', storageKey: 'pi.sidebarWidth', min: 180, max: 480, fromLeft: true, fallback: 264 }),
    []
  )
  const startPanelDrag = useCallback(
    startDrag({ cssVar: '--panel-w', storageKey: 'pi.panelWidth', min: 220, max: 640, fromLeft: false, fallback: 276 }),
    []
  )

  useEffect(() => {
    void store.init()
  }, [])

  const running = isRunning({ runningIds, session })
  const model = sessionModelOf({ session, config })
  const draft = session?.id === DRAFT_ID
  const onFork = useCallback((id: string) => void store.fork(id), [])
  const onSwitch = useCallback((id: string, dir: -1 | 1) => void store.switchBranch(id, dir), [])
  const onSend = useCallback((text: string, files: PickedFile[]) => store.send(text, files), [])
  const onAbort = useCallback(() => void store.abort(), [])
  const openSettings = useCallback(() => store.openSettings(), [])
  const closeSettings = useCallback(() => store.closeSettings(), [])
  const togglePanel = useCallback(() => store.togglePanel(), [])
  const togglePanelFull = useCallback(() => store.togglePanelFull(), [])

  if (!ready) return <Splash text="正在启动…" />
  if (fatal) return <Splash text={fatal} />

  return (
    <div
      ref={appRef}
      className={`app ${session && panelOpen ? 'with-panel' : ''} ${
        session && panelOpen && panelFull ? 'full-panel' : ''
      }`}
      style={
        {
          '--sidebar-w': `${sidebarW}px`,
          ...(panelW != null ? { '--panel-w': `${panelW}px` } : {})
        } as CSSProperties
      }
    >
      {/* 分割线：会话侧栏右缘（一直可用）；面板左缘（面板开着且非完整视图时） */}
      <div className="pane-split pane-split-sidebar" onMouseDown={startSidebarDrag} title="拖拽调整侧栏宽度" />
      {session && panelOpen && !panelFull && (
        <div className="pane-split pane-split-panel" onMouseDown={startPanelDrag} title="拖拽调整面板宽度" />
      )}
      <Sidebar />

      <section className="main">
        <header className="topbar">
          <div className="topbar-title" title={session?.cwd}>
            {session ? session.title || '未命名会话' : '没有打开的项目'}
          </div>
          <div className="topbar-right">
            {session && <SessionDir />}
            {session && <SessionModelPicker />}
            {session && <SessionThinking />}
            {running && (
              <span className="pill running">
                <span className="pill-dot" />
                运行中
              </span>
            )}
            {session && (
              <button
                className={`pane-ghost-btn as-icon ${panelOpen ? 'on' : ''}`}
                type="button"
                onClick={togglePanel}
                title="功能面板"
                aria-label="功能面板"
                aria-pressed={panelOpen}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <rect x="2" y="3" width="12" height="10" rx="1.2" />
                  <path d="M10.5 3v10" />
                </svg>
              </button>
            )}
            <button className="pane-ghost-btn as-icon" type="button" onClick={openSettings} title="设置 (Ctrl+,)" aria-label="设置">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <path d="M2.5 5.5h11M2.5 10.5h11" strokeLinecap="round" />
                <circle cx="10.2" cy="5.5" r="1.9" fill="var(--bg)" />
                <circle cx="5.8" cy="10.5" r="1.9" fill="var(--bg)" />
              </svg>
            </button>
          </div>
        </header>

        {session ? (
          <>
            <MessageList session={session} running={running} onFork={onFork} onSwitch={onSwitch} draft={draft} />

            <Composer
              sessionId={session.id}
              running={running}
              queue={queue}
              disabled={!model}
              needsModel={!model}
              model={model}
              supportsImages={modelSupportsImagesOf({ config, session, modelCache })}
              onSend={onSend}
              onAbort={onAbort}
            />
          </>
        ) : (
          <StartScreen />
        )}
      </section>

      {session && panelOpen && <SidePanel session={session} full={panelFull} onToggleFull={togglePanelFull} />}

      <StatusBar />
      <Toasts notices={notices} />
      <AskDialog />

      {settingsOpen && <SettingsDialog config={config} onClose={closeSettings} />}
    </div>
  )
}

const EMPTY_QUEUE: string[] = []
