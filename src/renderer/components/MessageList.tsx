import { memo, useEffect, useRef } from 'react'
import type { SessionView } from '@shared/types'
import { useSlice, type LiveState } from '../store'
import { MessageItem } from './MessageItem'
import { Markdown } from './Markdown'

interface Props {
  session: SessionView | null
  running: boolean
  onFork: (id: string) => void
  onSwitch: (id: string, dir: -1 | 1) => void
  /** 草稿会话：还没发过消息，也就还没落盘 */
  draft?: boolean
}

function LiveBubble({ live }: { live: LiveState }): JSX.Element {
  return (
    <div className="msg msg-assistant streaming">
      <div className="msg-head">
        <span className="avatar">M</span>
        <span className="msg-model">生成中</span>
        <span className="typing">
          <i />
          <i />
          <i />
        </span>
      </div>
      {!live.text && live.thinking && (
        <div className="msg-thinking">
          <span className="msg-thinking-label">思考中</span>
          <span className="msg-thinking-text">{live.thinking.replace(/\s+/g, ' ').trim()}</span>
        </div>
      )}

      {live.text ? <Markdown text={live.text} /> : null}
      {live.tools.map((t) => (
        <div className="tool-running" key={t.callId}>
          <span className="spinner" />
          <span className="tool-running-name">{t.name === 'task' && t.label ? `task · ${t.label}` : t.name}</span>
          <span className="tool-running-hint">{t.name === 'task' ? '子智能体执行中…' : '执行中…'}</span>
          {t.name === 'task' && live.subTools
            .filter((st) => st.taskCallId === t.callId)
            .map((st) => (
              <span className="tool-running-hint sub" key={st.callId}>
                {st.name === 'bash' && '⚡ '}
                {st.name}
              </span>
            ))}
        </div>
      ))}
    </div>
  )
}

function EmptyState({ draft }: { draft?: boolean }): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-state-mark">M</div>
      <h2>Metis</h2>
      <p>一个只管干活的极简编码代理：读文件、改代码、跑命令。</p>
      <ul>
        <li>
          <code>read</code> 读取工作目录内的文件
        </li>
        <li>
          <code>edit</code> 精确替换 / <code>write</code> 整文件写入
        </li>
        <li>
          <code>bash</code> 执行测试、构建与任意命令
        </li>
      </ul>
      <p className="empty-state-tip">
        {draft
          ? '发出第一条消息后才会创建这个项目；现在切走不会留下空会话。'
          : '在下方输入任务开始。运行中再发消息会追加进当前任务，而不是打断它。'}
      </p>
    </div>
  )
}

export const MessageList = memo(function MessageList({ session, running, onFork, onSwitch, draft }: Props): JSX.Element {
  const live = useSlice((s) => (session ? s.live[session.id] : undefined))
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [session?.messages.length, live?.text, live?.tools.length, running])

  const messages = session?.messages ?? []
  const lastAssistantIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i
    }
    return -1
  })()

  return (
    <div className="messages" ref={ref}>
      <div className="messages-inner">
        {!messages.length && !live ? (
          <EmptyState draft={draft} />
        ) : (
          messages.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              branch={session?.branch[m.id]}
              onFork={onFork}
              onSwitch={onSwitch}
              canFork={!running && m.role === 'assistant' && i !== lastAssistantIndex}
            />
          ))
        )}
        {live ? <LiveBubble live={live} /> : null}
        {running && !live ? (
          <div className="msg msg-assistant">
            <div className="msg-head">
              <span className="avatar">M</span>
              <span className="msg-model">继续处理中</span>
              <span className="typing">
                <i />
                <i />
                <i />
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
})
