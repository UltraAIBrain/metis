import { memo, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { SessionSummary } from '@shared/types'
import { store, useSlice } from '../store'
import { baseName, timeAgo } from '../util'

interface MenuState {
  id: string
  x: number
  y: number
}

function confirmDelete(item: SessionSummary): void {
  const title = item.title || '未命名会话'
  if (window.confirm(`确定永久删除会话「${title}」吗？此操作无法撤销。`)) void store.deleteSession(item.id)
}

function SessionRow({
  item,
  active,
  running,
  editing,
  draft,
  onDraft,
  onSelect,
  onContextMenu,
  onCommit,
  onCancel,
  onDelete
}: {
  item: SessionSummary
  active: boolean
  running: boolean
  editing: boolean
  draft: string
  onDraft: (v: string) => void
  onSelect: () => void
  onContextMenu: (e: ReactMouseEvent) => void
  onCommit: () => void
  onCancel: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div
      className={`session-row ${active ? 'active' : ''}`}
      onClick={editing ? undefined : onSelect}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !editing) onSelect()
      }}
    >
      {editing ? (
        <input
          className="session-rename"
          value={draft}
          autoFocus
          onChange={(e) => onDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={onCommit}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') onCommit()
            if (e.key === 'Escape') onCancel()
          }}
        />
      ) : (
        <div className="session-title">
          {item.pinned && (
            <svg className="pin-mark" width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.5 1.5 8 3l.7.7-3.2 3.2-1.6-.3-1 1 2.7 2.7 2.7 2.7 1-1-.3-1.6 3.2-3.2.7.7 1.5-1.5z" />
            </svg>
          )}
          {item.title || '未命名会话'}
          {running && <span className="dot-running" title="运行中" />}
        </div>
      )}
      <div className="session-meta">
        <span className={`session-dir ${item.cwd ? '' : 'auto'}`} title={item.cwd || '首次运行时自动创建'}>
          {item.cwd ? baseName(item.cwd) : '自动目录'}
        </span>
        <span className="session-time">{timeAgo(item.updatedAt)}</span>
        <span className="session-count">{item.messageCount} 条</span>
      </div>
      {!editing && (
        <button
          className="session-del"
          type="button"
          title="删除会话"
          aria-label={`删除会话 ${item.title || '未命名会话'}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

export const Sidebar = memo(function Sidebar(): JSX.Element {
  const sessions = useSlice((s) => s.sessions)
  const activeId = useSlice((s) => s.session?.id)
  const runningIds = useSlice((s) => s.runningIds)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  // 菜单：点空白、按 Esc、滚动都关掉
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  const openMenu = (e: ReactMouseEvent, id: string): void => {
    e.preventDefault()
    e.stopPropagation()
    // 贴着窗口边缘时往回收，别让菜单被裁掉
    const x = Math.min(e.clientX, window.innerWidth - 176)
    const y = Math.min(e.clientY, window.innerHeight - 172)
    setMenu({ id, x, y })
  }

  const startRename = (item: SessionSummary): void => {
    setMenu(null)
    setDraft(item.title || '')
    setEditingId(item.id)
  }

  const commitRename = (): void => {
    const id = editingId
    const title = draft.trim()
    setEditingId(null)
    if (!id || !title) return
    const current = sessions.find((s) => s.id === id)
    if (current && current.title === title) return
    void store.renameSession(id, title)
  }

  const menuItem = sessions.find((s) => s.id === menu?.id)

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">M</span>
        <span className="brand-text">
          Metis
        </span>
      </div>

      <div className="new-row">
        <button className="new-session" type="button" onClick={() => void store.newSession('auto')}>
          <span className="plus">＋</span> 新建项目
        </button>
      </div>

      <div className="session-list">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            item={s}
            active={s.id === activeId}
            running={runningIds.includes(s.id)}
            editing={editingId === s.id}
            draft={draft}
            onDraft={setDraft}
            onSelect={() => void store.selectSession(s.id)}
            onContextMenu={(e) => openMenu(e, s.id)}
            onCommit={commitRename}
            onCancel={() => setEditingId(null)}
            onDelete={() => confirmDelete(s)}
          />
        ))}
        {!sessions.length && <div className="session-empty">还没有项目</div>}
      </div>

      <div className="sidebar-foot">
        <div className="foot-actions">
          <button type="button" onClick={() => store.openSettings()}>
            设置
          </button>
          <span className="sep">·</span>
          <button type="button" onClick={() => void store.openLogs()}>
            日志
          </button>
        </div>
      </div>

      {menu && (
        <div
          className="session-menu"
          ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={() => {
              if (menuItem) startRename(menuItem)
            }}
          >
            重命名任务
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void store.revealSession(menu.id)
            }}
          >
            从资源管理器中打开
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void store.exportTrajectory(menu.id, 'md')
            }}
          >
            导出轨迹 (Markdown)
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(null)
              void store.exportTrajectory(menu.id, 'json')
            }}
          >
            导出轨迹 (JSON)
          </button>
          <button
            type="button"
            onClick={() => {
              const pinned = Boolean(menuItem?.pinned)
              setMenu(null)
              void store.setSessionPinned(menu.id, !pinned)
            }}
          >
            {menuItem?.pinned ? '取消置顶' : '置顶任务'}
          </button>
          <div className="session-menu-sep" />
          <button
            type="button"
            className="danger"
            onClick={() => {
              setMenu(null)
              if (menuItem) confirmDelete(menuItem)
            }}
          >
            删除会话
          </button>
        </div>
      )}
    </aside>
  )
})
