import { useEffect, useRef, useState } from 'react'
import type { SessionSearchHit } from '@shared/types'
import { store, useSlice } from '../store'

/**
 * 没有打开项目时的起始页：新建入口 + 历史会话全文检索
 * （扫最近 50 个会话的消息文本，按相关度排序，点结果直接进会话）。
 */

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export function StartScreen(): JSX.Element {
  const hasProjects = useSlice((s) => s.sessions.length > 0)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const seq = useRef(0)
  /** 200ms 防抖：搜索在主进程是同步扫 JSONL，逐键触发会卡输入 */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSearch = (raw: string): void => {
    const q = raw.trim()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q) {
      setHits(null)
      setSearching(false)
      return
    }
    const request = ++seq.current
    setSearching(true)
    debounceRef.current = setTimeout(() => {
      window.pi
        .searchSessions(q)
        .then((found) => {
          if (seq.current === request) setHits(found)
        })
        .catch(() => {
          if (seq.current === request) setHits([])
        })
        .finally(() => {
          if (seq.current === request) setSearching(false)
        })
    }, 200)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return (
    <div className="empty-state">
      <div className="empty-state-mark">M</div>
      <h2>{hasProjects ? '没有打开的项目' : '新建项目'}</h2>
      <p>
        每个项目绑定一个工作目录。可以直接新建——第一次发送消息时会在
        <code>~/.metis/projects</code> 下自动建一个；也可以现在指定一个已有仓库。
      </p>

      <div className="start-actions">
        <button className="btn-primary" type="button" onClick={() => void store.newSession('auto')}>
          新建项目
        </button>
        <button className="btn-ghost" type="button" onClick={() => void store.newSession('pick')}>
          选择目录…
        </button>
      </div>

      {hasProjects && (
        <div className="start-search">
          <input
            value={query}
            placeholder="搜索历史会话…（消息全文）"
            onChange={(e) => {
              setQuery(e.target.value)
              runSearch(e.target.value)
            }}
          />
          {searching && <span className="start-search-hint">搜索中…</span>}
          {hits && !searching && !hits.length && <span className="start-search-hint">没有匹配的历史消息</span>}
          {hits && hits.length > 0 && (
            <div className="start-hits">
              {hits.map((h) => (
                <button
                  key={h.messageId}
                  type="button"
                  className="start-hit"
                  onClick={() => void store.selectSession(h.sessionId)}
                  title={`进入会话：${h.title}`}
                >
                  <span className="start-hit-title">
                    {h.title}
                    <i>{h.role === 'user' ? '问' : h.role === 'assistant' ? '答' : '果'}</i>
                  </span>
                  <span className="start-hit-snippet">{h.snippet}</span>
                  <span className="start-hit-time">{timeAgo(h.ts)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <ul>
        <li>
          <code>read</code> 读取文件
        </li>
        <li>
          <code>edit</code> 精确替换 / <code>write</code> 整文件写入
        </li>
        <li>
          <code>bash</code> 执行测试、构建与任意命令
        </li>
      </ul>
    </div>
  )
}
