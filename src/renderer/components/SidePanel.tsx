import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeList, SessionView } from '@shared/types'
import { artifactsOf, store } from '../store'
import { baseName, timeAgo } from '../util'
import { DiffView } from './DiffView'
import { BrowserPane } from './panel/BrowserPane'
import { FilesPane } from './panel/FilesPane'
import { TerminalPane } from './panel/TerminalPane'
import { TracePane } from './panel/TracePane'

function Icon({ name }: { name: string }): JSX.Element {
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }
  if (name === 'browser') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <ellipse cx="8" cy="8" rx="2.6" ry="6" />
        <path d="M2 8h12" />
      </svg>
    )
  }
  if (name === 'folder') {
    return (
      <svg {...common}>
        <path d="M2 4.5a1 1 0 011-1h3l1.5 1.8H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1z" strokeLinejoin="round" />
      </svg>
    )
  }
  if (name === 'changes') {
    return (
      <svg {...common}>
        <path d="M4.5 2.5v11M2.5 4.5l2-2 2 2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M11.5 13.5v-11M9.5 11.5l2 2 2-2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (name === 'terminal') {
    return (
      <svg {...common}>
        <rect x="2" y="3" width="12" height="10" rx="1.2" />
        <path d="M4.5 6.5l2 2-2 2M8 10.5h3.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (name === 'expand') {
    return (
      <svg {...common}>
        <path d="M6 2.5H2.5V6M10 2.5h3.5V6M6 13.5H2.5V10M10 13.5h3.5V10" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (name === 'doc') {
    return (
      <svg {...common}>
        <path d="M4 2h5l3 3v9H4z" strokeLinejoin="round" />
        <path d="M9 2v3h3M6 8h4M6 10.5h4" strokeLinecap="round" />
      </svg>
    )
  }
  if (name === 'trace') {
    return (
      <svg {...common}>
        <circle cx="4" cy="4" r="1.6" />
        <circle cx="8" cy="8" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <path d="M5.2 4.9L6.8 7.1M9.2 8.9l1.6 2.2" strokeLinecap="round" />
      </svg>
    )
  }
  if (name === 'sidebar') {
    return (
      <svg {...common}>
        <rect x="2" y="3" width="12" height="10" rx="1.2" />
        <path d="M10 3v10" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M5 6l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 产物文件的小图标：按扩展名给不同颜色与形状 */
function FileGlyph({ path }: { path: string }): JSX.Element {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  const cls =
    ext === 'md'
      ? 'glyph-md'
      : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ico'].includes(ext)
        ? 'glyph-img'
        : ['js', 'ts', 'tsx', 'jsx', 'json', 'css', 'html', 'py', 'rs', 'go', 'sh', 'sql', 'yml', 'yaml', 'toml'].includes(ext)
          ? 'glyph-code'
          : 'glyph-page'
  if (cls === 'glyph-img') {
    return (
      <svg className={`file-glyph ${cls}`} width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <rect x="2" y="2.5" width="12" height="11" rx="1.4" />
        <circle cx="5.8" cy="6" r="1.1" />
        <path d="M2.5 11.5l3.2-3 2.6 2.4 2.2-2 3 2.8" strokeLinejoin="round" />
      </svg>
    )
  }
  if (cls === 'glyph-code') {
    return (
      <svg className={`file-glyph ${cls}`} width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M5.5 5L2.8 8l2.7 3M10.5 5l2.7 3-2.7 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <span className={`file-glyph ${cls}`}>{cls === 'glyph-md' ? 'M' : ''}</span>
  )
}

const STATUS_CLASS: Record<string, string> = { A: 'add', '??': 'untracked', D: 'del' }

function statusClass(s: string): string {
  if (s === '??') return STATUS_CLASS['??']
  if (s.includes('A')) return STATUS_CLASS.A
  if (s.includes('D')) return STATUS_CLASS.D
  return 'mod'
}

function statusLabel(s: string): string {
  if (s === '??' || s.includes('A')) return '新增'
  if (s.includes('D')) return '删除'
  if (s.includes('R')) return '重命名'
  if (s.includes('M')) return '修改'
  return s
}

type View = 'menu' | 'changes' | 'browser' | 'files' | 'terminal' | 'trace'

/** 面板标签页：每个标签有自己的视图；「新标签页」与浏览器标签可多个并存 */
interface PanelTab {
  id: string
  view: View
  /** 创建时间，标签列表里显示相对时间 */
  createdAt: number
  /** 浏览器标签：当前地址（新选项卡由链接点击创建时带上） */
  url?: string
}

/** 折叠判据：芯片等分自适应宽度（46–150px），按最小宽度算能放下几个，放不下的旧标签折进「⌄」 */
const TAB_MIN = 50 /* 46px 下限 + 4px 间距 */

/** 标签页的标题与图标（menu = 截图里的「新标签页」：放着动作按钮的页面） */
const TAB_META: Record<View, { title: string; icon: string }> = {
  menu: { title: '新标签页', icon: 'doc' },
  browser: { title: '浏览器', icon: 'browser' },
  files: { title: '工作空间', icon: 'folder' },
  changes: { title: '变更', icon: 'changes' },
  terminal: { title: '终端', icon: 'terminal' },
  trace: { title: '轨迹', icon: 'trace' }
}

/** 标签显示名：浏览器标签显示当前站点（去 www.），其余用固定名 */
function tabLabel(t: PanelTab): string {
  if (t.view === 'browser' && t.url) {
    try {
      return new URL(t.url).host.replace(/^www\./, '') || TAB_META.browser.title
    } catch {
      return TAB_META.browser.title
    }
  }
  return TAB_META[t.view].title
}

interface Props {
  session: SessionView
  /** 完整视图：面板接管聊天区，顶部多选项卡切换 */
  full: boolean
  onToggleFull: () => void
}

export const SidePanel = memo(function SidePanel({ session, full, onToggleFull }: Props): JSX.Element {
  const [changes, setChanges] = useState<ChangeList | null>(null)
  const [changesLoading, setChangesLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diffText, setDiffText] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [showArtifacts, setShowArtifacts] = useState(true)
  /** 终端懒挂载：首次点开才创建（shell 进程），之后常驻保留状态；
   *  浏览器不需要这个开关——每个浏览器选项卡一个独立实例，随标签创建/关闭 */
  const [termMounted, setTermMounted] = useState(false)
  /** 浏览器式标签页：「＋」恒新建空白起始页，动作按钮把当前标签导航到对应功能 */
  const [tabs, setTabs] = useState<PanelTab[]>([{ id: 'tab-0', view: 'menu', createdAt: Date.now() }])
  const [activeId, setActiveId] = useState('tab-0')
  const tabSeq = useRef(1)
  /** 标签列表弹层（⌄）：搜索 + 全部已开标签 */
  const [tabListOpen, setTabListOpen] = useState(false)
  const [tabFilter, setTabFilter] = useState('')
  /** 标签右键菜单：关闭 / 关闭其他 / 关闭右侧 / 关闭全部 */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const tabMenuRef = useRef<HTMLDivElement>(null)
  /** 折叠边界：tabs.slice(foldFrom) 之前的旧标签不占标签栏，收进「⌄」列表（宽度不够时从最旧开始折） */
  const [foldFrom, setFoldFrom] = useState(0)
  const tabsScrollRef = useRef<HTMLDivElement>(null)
  const chipRefs = useRef(new Map<string, HTMLDivElement>())
  const sessionRef = useRef(session.id)
  const changesRequest = useRef(0)
  const diffRequest = useRef(0)
  sessionRef.current = session.id

  /** 当前激活标签的视图（驱动内容区渲染） */
  const view = tabs.find((t) => t.id === activeId)?.view ?? 'menu'
  /** 折叠起点：保证激活标签永远可见（从 ⌄ 列表点开被折叠的标签时把它顶回标签栏） */
  const activeIdx = tabs.findIndex((t) => t.id === activeId)
  const visibleFrom = activeIdx >= 0 ? Math.min(foldFrom, activeIdx) : foldFrom
  const nextTabId = (): string => `tab-${tabSeq.current++}`

  /* 芯片等分自适应：少时撑满、多时收缩；收缩到下限仍放不下才从最旧开始折叠。
     面板拖宽/窗口缩放实时重算（可放数量 = 滚动区实测宽 / 最小芯片宽） */
  useLayoutEffect(() => {
    const scroll = tabsScrollRef.current
    if (!scroll) return
    const recompute = (): void => {
      const avail = scroll.clientWidth - 4
      const fitted = Math.max(1, Math.min(tabs.length, Math.floor(avail / TAB_MIN)))
      let from = tabs.length - fitted
      const ai = tabs.findIndex((t) => t.id === activeId)
      if (ai >= 0 && ai < from) from = ai
      setFoldFrom((prev) => (prev === from ? prev : from))
    }
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(scroll)
    return () => ro.disconnect()
  }, [tabs, activeId])

  /* 激活标签始终滚进可视区（从 ⌄ 列表激活被折叠/滚出的标签时） */
  useEffect(() => {
    chipRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, visibleFrom])

  /* 标签右键菜单：点其他地方关闭 */
  useEffect(() => {
    if (!tabMenu) return
    const close = (e: MouseEvent): void => {
      if (tabMenuRef.current && !tabMenuRef.current.contains(e.target as Node)) setTabMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [tabMenu])

  /* Ctrl/Cmd+Tab 在面板标签间循环（Shift 反向） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== 'Tab' || tabs.length < 2) return
      e.preventDefault()
      const idx = tabs.findIndex((t) => t.id === activeId)
      const target = tabs[(idx + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]
      setActiveId(target.id)
      if (target.view === 'changes' && !changes) void loadChanges()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabs, activeId, changes])

  useEffect(() => {
    changesRequest.current++
    diffRequest.current++
    // 切会话回到「新标签页」；变更视图是会话级数据，一并退回
    setTabs((prev) => prev.map((t) => (t.id === activeId || t.view === 'changes' ? { ...t, view: 'menu' } : t)))
    setChanges(null)
    setChangesLoading(false)
    setExpanded(null)
    setDiffText(null)
    setDiffLoading(false)
  }, [session.id])

  const artifacts = useMemo(() => artifactsOf(session), [session])

  const loadChanges = async (): Promise<void> => {
    const sessionId = session.id
    const request = ++changesRequest.current
    diffRequest.current++
    setChangesLoading(true)
    setExpanded(null)
    setDiffText(null)
    try {
      const result = await store.fetchChanges(sessionId)
      if (request !== changesRequest.current || sessionRef.current !== sessionId) return
      setChanges(result)
    } catch (err) {
      if (request !== changesRequest.current || sessionRef.current !== sessionId) return
      store.notify('error', `读取变更失败：${(err as Error).message}`)
      setChanges({ supported: false, files: [] })
    } finally {
      if (request === changesRequest.current && sessionRef.current === sessionId) setChangesLoading(false)
    }
  }

  const toggleFile = async (file: string, status: string): Promise<void> => {
    const sessionId = session.id
    const request = ++diffRequest.current
    if (expanded === file) {
      setExpanded(null)
      setDiffText(null)
      setDiffLoading(false)
      return
    }
    setExpanded(file)
    if (status === '??' || status === 'A') {
      setDiffText('')
      setDiffLoading(false)
      return
    }
    setDiffLoading(true)
    try {
      const result = await store.fetchDiff(sessionId, file)
      if (request !== diffRequest.current || sessionRef.current !== sessionId) return
      setDiffText(result)
    } catch (err) {
      if (request !== diffRequest.current || sessionRef.current !== sessionId) return
      store.notify('error', `读取差异失败：${(err as Error).message}`)
      setDiffText('')
    } finally {
      if (request === diffRequest.current && sessionRef.current === sessionId) setDiffLoading(false)
    }
  }

  /**
   * 打开一个功能 = 把当前激活的标签页导航到该视图（标签芯片随之变为对应名称）；
   * 浏览器例外：每个浏览器选项卡一个独立实例——已有浏览器标签则激活，没有则新建（带首页地址）；
   * 链接的 window.open 请求走 createBrowserTab 永远开**新**选项卡。
   */
  const openFeature = (key: View): void => {
    if (key === 'terminal') setTermMounted(true)
    if (key === 'browser') {
      const existing = tabs.find((t) => t.view === 'browser')
      if (existing) {
        setActiveId(existing.id)
        return
      }
      createBrowserTab()
      return
    }
    if (key === 'changes') void loadChanges()
    setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, view: key } : t)))
  }

  /** 新建一个浏览器选项卡（链接 target=_blank / 菜单「打开浏览器」首开），并激活 */
  const createBrowserTab = (url?: string): void => {
    const tab: PanelTab = { id: nextTabId(), view: 'browser', createdAt: Date.now(), url }
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
  }

  /** 浏览器导航地址回传：选项卡芯片显示站点名 */
  const updateBrowserUrl = (id: string, url: string): void => {
    setTabs((prev) => prev.map((t) => (t.id === id && t.url !== url ? { ...t, url } : t)))
  }

  /** 激活一个标签页；变更视图数据被清过（如刚切会话）时自动重载 */
  const activateTab = (id: string): void => {
    setActiveId(id)
    const target = tabs.find((t) => t.id === id)
    if (target?.view === 'changes' && !changes) void loadChanges()
  }

  /** 终端实例只在"最后一个使用它的标签"关闭时才销毁；浏览器实例随标签关闭自动卸载 */
  const dropViews = (closed: PanelTab[], next: PanelTab[]): void => {
    if (closed.some((t) => t.view === 'terminal') && !next.some((t) => t.view === 'terminal')) {
      void store.killTerm(session.id)
      setTermMounted(false)
    }
  }

  /** 关闭标签页；全部关光自动补一个新标签页 */
  const closeTab = (id: string): void => {
    const idx = tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const next = tabs.filter((t) => t.id !== id)
    dropViews([tabs[idx]], next)
    if (!next.length) {
      const fresh: PanelTab = { id: nextTabId(), view: 'menu', createdAt: Date.now() }
      setTabs([fresh])
      setActiveId(fresh.id)
      return
    }
    setTabs(next)
    if (id === activeId) setActiveId(next[Math.min(idx, next.length - 1)].id)
  }

  /** 批量关闭（右键菜单的关闭其他 / 右侧 / 全部） */
  const closeMany = (ids: string[]): void => {
    const idSet = new Set(ids)
    const closed = tabs.filter((t) => idSet.has(t.id))
    if (!closed.length) return
    const next = tabs.filter((t) => !idSet.has(t.id))
    dropViews(closed, next)
    if (!next.length) {
      const fresh: PanelTab = { id: nextTabId(), view: 'menu', createdAt: Date.now() }
      setTabs([fresh])
      setActiveId(fresh.id)
      return
    }
    setTabs(next)
    if (!next.some((t) => t.id === activeId)) {
      const idx = tabs.findIndex((t) => t.id === activeId)
      setActiveId(next[Math.min(Math.max(idx, 0), next.length - 1)].id)
    }
  }

  /** 「＋」新建一个「新标签页」（空白起始页），可多个并存 */
  const addMenuTab = (): void => {
    const fresh: PanelTab = { id: nextTabId(), view: 'menu', createdAt: Date.now() }
    setTabs((prev) => [...prev, fresh])
    setActiveId(fresh.id)
  }

  /** 展开 / 收起完整视图：标签页集合两种模式共用，切换不丢已开的标签 */
  const toggleFull = (): void => onToggleFull()

  const artifactsList =
    artifacts.length === 0 ? (
      <div className="panel-empty">本次会话还没有产出文件</div>
    ) : (
      <div className="panel-artifacts">
        {artifacts.map((a) => (
          <button
            className="panel-file-row"
            type="button"
            key={a.path}
            title={`打开 ${a.path}`}
            onClick={() => void store.openWorkspaceFile(session.id, a.path)}
          >
            <FileGlyph path={a.path} />
            <span className="panel-file-name">{baseName(a.path)}</span>
            <span className="artifact-kind">{a.kind === 'write' ? '新建' : '修改'}</span>
          </button>
        ))}
      </div>
    )

  return (
    <aside className={`side-panel ${full ? 'panel-full' : ''}`}>
      {/* 标签栏：⌄ 与尾部按钮（＋/⤢/⧉）钉在滚动区外，标签再多也挤不走它们 */}
      <div className="panel-tabs">
        <button
          className={`panel-tablist-btn ${tabListOpen ? 'active' : ''}`}
          type="button"
          title="打开的标签页"
          onClick={() => {
            setTabListOpen((v) => !v)
            setTabFilter('')
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M3.5 6l4.5 4.5L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {visibleFrom > 0 && <span className="panel-tablist-badge">{visibleFrom}</span>}
        </button>
        <div
          className="panel-tabs-scroll"
          ref={tabsScrollRef}
          onDoubleClick={(e) => {
            if (e.target === e.currentTarget) addMenuTab()
          }}
        >
          {tabs.slice(visibleFrom).map((t) => (
            <div
              key={t.id}
              ref={(el) => {
                if (el) chipRefs.current.set(t.id, el)
                else chipRefs.current.delete(t.id)
              }}
              className={`panel-tab-item ${t.id === activeId ? 'active' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ x: e.clientX, y: e.clientY, id: t.id })
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  closeTab(t.id)
                }
              }}
            >
              <button className="panel-tab" type="button" title={tabLabel(t)} onClick={() => activateTab(t.id)}>
                <Icon name={TAB_META[t.view].icon} />
                <span>{tabLabel(t)}</span>
              </button>
              <button className="panel-tab-close" type="button" title="关闭标签页" onClick={() => closeTab(t.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="panel-tabs-trail">
          <button className="panel-tab-add" type="button" title="新建标签页" onClick={addMenuTab}>
            +
          </button>
          <button
            className="pane-win-btn"
            type="button"
            title={full ? '收起完整视图，回到聊天区' : '展开完整视图（面板接管聊天区）'}
            onClick={toggleFull}
          >
            <Icon name="expand" />
          </button>
          <button
            className="pane-win-btn"
            type="button"
            title="收起面板（顶栏「面板」按钮可再次打开）"
            onClick={() => store.togglePanel()}
          >
            <Icon name="sidebar" />
          </button>
        </div>
      </div>

      {/* 标签列表弹层：搜索过滤 + 相对时间 + 行内关闭 */}
      {tabListOpen && (
        <>
          <div className="tablist-backdrop" onClick={() => setTabListOpen(false)} />
          <div className="tablist-pop">
            <input
              className="tablist-search"
              type="text"
              placeholder="搜索标签页…"
              value={tabFilter}
              onChange={(e) => setTabFilter(e.target.value)}
              autoFocus
            />
            <div className="tablist-head">打开的标签页</div>
            <div className="tablist-rows">
              {tabs
                .filter((t) => tabLabel(t).toLowerCase().includes(tabFilter.trim().toLowerCase()))
                .map((t) => (
                  <div key={t.id} className={`tablist-row ${t.id === activeId ? 'active' : ''}`}>
                    <button
                      className="tablist-open"
                      type="button"
                      onClick={() => {
                        activateTab(t.id)
                        setTabListOpen(false)
                      }}
                    >
                      <Icon name={TAB_META[t.view].icon} />
                      <span className="tablist-title">{tabLabel(t)}</span>
                      <span className="tablist-time">{timeAgo(t.createdAt)}</span>
                    </button>
                    <button className="tablist-close" type="button" title="关闭标签页" onClick={() => closeTab(t.id)}>
                      ×
                    </button>
                  </div>
                ))}
              {tabs.every((t) => !tabLabel(t).toLowerCase().includes(tabFilter.trim().toLowerCase())) && (
                <div className="tablist-empty">没有匹配的标签页</div>
              )}
            </div>
          </div>
        </>
      )}

      {/* 标签右键菜单：浏览器式批量关闭 */}
      {tabMenu && (
        <div
          className="session-menu"
          ref={tabMenuRef}
          style={{ left: tabMenu.x, top: tabMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              const id = tabMenu.id
              setTabMenu(null)
              closeTab(id)
            }}
          >
            关闭标签页
          </button>
          <button
            type="button"
            onClick={() => {
              const id = tabMenu.id
              setTabMenu(null)
              closeMany(tabs.filter((t) => t.id !== id).map((t) => t.id))
            }}
          >
            关闭其他标签页
          </button>
          <button
            type="button"
            onClick={() => {
              const idx = tabs.findIndex((t) => t.id === tabMenu.id)
              setTabMenu(null)
              closeMany(tabs.slice(idx + 1).map((t) => t.id))
            }}
          >
            关闭右侧标签页
          </button>
          <div className="session-menu-sep" />
          <button
            type="button"
            onClick={() => {
              setTabMenu(null)
              closeMany(tabs.map((t) => t.id))
            }}
          >
            关闭全部标签页
          </button>
        </div>
      )}

      {/* 「新标签页」起始页：品牌头（π + 项目目录）→ 动作列表 → 产物区，同一列 */}
      {view === 'menu' && (
        <div className="panel-menu-page">
          <div className="panel-brand" title={session.cwd}>
            <span className="panel-brand-mark">π</span>
            <span className="panel-brand-name">{baseName(session.cwd) || '自动目录'}</span>
          </div>
          <div className="panel-actions">
          <button className="panel-action" type="button" onClick={() => openFeature('browser')}>
            <Icon name="browser" />
            <span>打开浏览器</span>
          </button>
          <button className="panel-action" type="button" onClick={() => openFeature('files')} title={session.cwd}>
            <Icon name="folder" />
            <span>查看工作空间</span>
          </button>
          <button className="panel-action" type="button" onClick={() => openFeature('changes')}>
            <Icon name="changes" />
            <span>查看变更</span>
          </button>
          <button className="panel-action" type="button" onClick={() => openFeature('terminal')}>
            <Icon name="terminal" />
            <span>打开终端</span>
          </button>
          <button className="panel-action" type="button" onClick={() => openFeature('trace')} title="按回合查看模型响应与工具往返（参数 / 结果 / 耗时）">
            <Icon name="trace" />
            <span>查看轨迹</span>
          </button>
          {!full && (
            <button className="panel-action" type="button" onClick={toggleFull} title="面板接管聊天区，多标签页切换">
              <Icon name="expand" />
              <span>完整视图</span>
            </button>
          )}
          </div>

          <div className="panel-section">
            <button className="panel-section-head" type="button" onClick={() => setShowArtifacts((v) => !v)}>
              <span>产物（{artifacts.length}）</span>
              <svg className={`chevron ${showArtifacts ? 'open' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M5 6l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {showArtifacts && artifactsList}
          </div>
        </div>
      )}

      {view === 'changes' && (
        <>
          <div className="panel-view-head">
            <span>变更{changes?.supported ? `（${changes.files.length}）` : ''}</span>
            <button
              className="panel-refresh"
              type="button"
              title="刷新"
              disabled={changesLoading}
              onClick={() => void loadChanges()}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M13.5 8a5.5 5.5 0 11-1.6-3.9" strokeLinecap="round" />
                <path d="M13.7 1.8v2.7h-2.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <div className="panel-changes-list">
          {changesLoading ? (
            <div className="panel-empty">读取中…</div>
          ) : !changes?.supported ? (
            <div className="panel-empty">当前目录不是 Git 仓库</div>
          ) : changes.files.length === 0 ? (
            <div className="panel-empty">没有未提交的变更</div>
          ) : (
            changes.files.map((f) => (
              <div key={f.path} className="panel-change">
                <button className="panel-file-row" type="button" onClick={() => void toggleFile(f.path, f.status)}>
                  <span className={`change-status ${statusClass(f.status)}`}>{statusLabel(f.status)}</span>
                  <span className="panel-file-name" title={f.path}>
                    {f.path}
                  </span>
                </button>
                {expanded === f.path && (
                  <div className="panel-diff">
                    {f.status === '??' || f.status === 'A' ? (
                      <div className="panel-empty">未跟踪的新文件，暂无差异</div>
                    ) : diffLoading ? (
                      <div className="panel-empty">读取差异…</div>
                    ) : diffText ? (
                      <DiffView diff={diffText} />
                    ) : (
                      <div className="panel-empty">无差异</div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
          </div>
        </>
      )}

      {view === 'files' && <FilesPane session={session} />}
      {view === 'trace' && <TracePane sessionId={session.id} />}

      {/* 浏览器选项卡：每个标签一个独立实例，全部常驻挂载（切走不丢页面），按 activeId 显隐 */}
      {tabs
        .filter((t) => t.view === 'browser')
        .map((t) => (
          <div key={t.id} className={activeId === t.id ? 'pane-slot' : 'pane-slot pane-hidden'}>
            <BrowserPane
              initialUrl={t.url}
              onOpenTab={(url) => createBrowserTab(url)}
              onNavigate={(url) => updateBrowserUrl(t.id, url)}
            />
          </div>
        ))}
      {termMounted && (
        <div className={view === 'terminal' ? 'pane-slot' : 'pane-slot pane-hidden'}>
          <TerminalPane sessionId={session.id} />
        </div>
      )}
    </aside>
  )
})
