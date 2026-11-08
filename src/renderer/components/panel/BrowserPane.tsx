import { memo, useEffect, useRef, useState } from 'react'

/**
 * 面板内嵌浏览器：`<webview>`（guest 页面独立进程、仍受沙箱隔离）。
 * 每个浏览器选项卡一个实例（切走再切回不丢页面状态，靠常驻挂载 + display 切换）。
 * guest 里的 window.open（target=_blank 链接）经主进程转发到这里 → onOpenTab 开新选项卡。
 */

const HOME = ''

/** 输入既像 URL 也像搜索词：能补协议的补协议，否则当必应搜索 */
export function normalizeUrl(raw: string): string {
  const t = raw.trim()
  if (!t) return HOME
  if (/^https?:\/\//i.test(t)) return t
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) return `https://${t}`
  return `https://www.bing.com/search?q=${encodeURIComponent(t)}`
}

interface Props {
  /** 初始地址（新选项卡由链接点击创建时带目标 URL） */
  initialUrl?: string
  /** guest 请求开新窗口 → 在新浏览器选项卡中打开 */
  onOpenTab: (url: string) => void
  /** 导航地址变化 → 选项卡标题同步显示站点 */
  onNavigate?: (url: string) => void
}

export const BrowserPane = memo(function BrowserPane({ initialUrl, onOpenTab, onNavigate }: Props): JSX.Element {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ref = useRef<any>(null)
  const [address, setAddress] = useState(() => (initialUrl?.trim() ? normalizeUrl(initialUrl) : HOME))
  /** 是否已经离开空白首页（首页是渲染层的空态页，不加载 webview） */
  const [navigated, setNavigated] = useState(() => Boolean(initialUrl?.trim()))
  const [loading, setLoading] = useState(false)
  const navigateRef = useRef(onNavigate)
  navigateRef.current = onNavigate
  const openTabRef = useRef(onOpenTab)
  openTabRef.current = onOpenTab

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const onNavigateEvent = (e: { url: string }): void => {
      setAddress(e.url)
      navigateRef.current?.(e.url)
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => setLoading(false)
    // guest 的 window.open：按 guestId 认领（只有发起的那个实例开新选项卡）；
    // 回调里动态取 ref.current，兼容空白首页 ↔ webview 的卸载/重挂载
    const offOpen = window.pi.onBrowserOpenTab((payload) => {
      const el = ref.current
      if (el?.getWebContentsId?.() === payload.guestId) openTabRef.current(payload.url)
    })
    wv.addEventListener('did-navigate', onNavigateEvent)
    wv.addEventListener('did-navigate-in-page', onNavigateEvent)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    return () => {
      wv.removeEventListener('did-navigate', onNavigateEvent)
      wv.removeEventListener('did-navigate-in-page', onNavigateEvent)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      offOpen()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigated])

  const go = (): void => {
    const url = normalizeUrl(address)
    if (!url) return
    setAddress(url)
    setNavigated(true)
    ref.current?.loadURL(url)
  }

  return (
    <div className="panel-pane">
      <div className="pane-toolbar">
        <button className="pane-btn" type="button" title="后退" onClick={() => ref.current?.goBack()}>
          ‹
        </button>
        <button className="pane-btn" type="button" title="前进" onClick={() => ref.current?.goForward()}>
          ›
        </button>
        <button className="pane-btn" type="button" title="刷新" onClick={() => ref.current?.reload()}>
          ↻
        </button>
        <button
          className="pane-btn"
          type="button"
          title="空白首页"
          onClick={() => {
            setAddress(HOME)
            setNavigated(false)
            navigateRef.current?.('')
          }}
        >
          ⌂
        </button>
        <input
          className="pane-url"
          type="text"
          value={address}
          spellCheck={false}
          placeholder="输入网址或搜索词"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
              go()
            }
          }}
        />
        {loading && <span className="pane-loading">加载中…</span>}
      </div>
      <div className="pane-web">
        {navigated ? (
          /* allowpopups：让 window.open 走到主进程的 setWindowOpenHandler（在那里转成新选项卡并 deny）。
              Electron 要求该 attribute 在元素 attach 前就位；React 18 对自定义元素 boolean 不落 DOM、
              ref 回调又晚于 attach——所以用字符串值 + 类型断言（运行时确实按 attribute 渲染） */
          <webview ref={ref} src={address} allowpopups={'true' as unknown as boolean} />
        ) : (
          <div className="pane-blank">
            <div className="pane-blank-mark">π</div>
            <p className="pane-blank-title">空白首页</p>
            <p className="pane-blank-hint">在上方输入网址或搜索词开始浏览</p>
          </div>
        )}
      </div>
    </div>
  )
})
