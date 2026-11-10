import { memo } from 'react'
import type { AssistantMessage, BranchInfo, Message, ToolMessage } from '@shared/types'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { formatSize } from '../util'

function textOf(m: AssistantMessage): string {
  return m.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')
}

interface Props {
  message: Message
  branch?: BranchInfo
  onFork: (id: string) => void
  onSwitch: (id: string, dir: -1 | 1) => void
  canFork: boolean
  /** 失败的这条回复就是当前叶子时，才允许"重试这一步"（回退一格重新生成） */
  canRetry?: boolean
  onRetry?: () => void
}

export const MessageItem = memo(function MessageItem({
  message,
  branch,
  onFork,
  onSwitch,
  canFork,
  canRetry,
  onRetry
}: Props): JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="user-bubble">
          {message.text}
          {message.attachments?.length ? (
            <div className="msg-attachments">
              {message.attachments.map((a) => (
                <span className={`msg-attach ${a.kind}`} key={a.id} title={`${a.name} · ${formatSize(a.size)}`}>
                  {a.kind === 'image' ? '🖼' : '📄'} {a.name}
                  <span className="msg-attach-size">{formatSize(a.size)}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  if (message.role === 'tool') {
    return <ToolCard message={message as ToolMessage} />
  }

  const text = textOf(message)
  const hasTools = message.blocks.some((b) => b.type === 'tool_use')

  return (
    <div className={`msg msg-assistant ${message.stopReason === 'error' ? 'failed' : ''}`}>
      <div className="msg-head">
        <span className="avatar">M</span>
        <span className="msg-model">{message.model}</span>
        {message.stopReason === 'aborted' && <span className="tag">已中止</span>}
        {message.stopReason === 'error' && <span className="tag err">出错</span>}

        <div className="msg-tools">
          {branch && (
            <span className="branch-switch">
              <button type="button" onClick={() => onSwitch(message.id, -1)} disabled={branch.index === 0} title="上一个分支">
                ‹
              </button>
              <span className="branch-label">
                {branch.index + 1}/{branch.count}
              </span>
              <button
                type="button"
                onClick={() => onSwitch(message.id, 1)}
                disabled={branch.index === branch.count - 1}
                title="下一个分支"
              >
                ›
              </button>
            </span>
          )}
          {canFork && (
            <button className="ghost-btn" type="button" onClick={() => onFork(message.id)} title="从这条消息分叉出新分支">
              分叉
            </button>
          )}
        </div>
      </div>

      {text ? <Markdown text={text} /> : null}
      {!text && !hasTools && !message.error && <div className="msg-muted">（无文本输出）</div>}
      {message.error && (
        <div className="msg-error">
          <span className="msg-error-title">请求失败</span>
          <pre>{message.error}</pre>
          {canRetry && (
            <button
              className="retry-btn"
              type="button"
              onClick={onRetry}
              title="用同一份上下文重新请求这一步，不新增消息；失败的那次会留成兄弟分支"
            >
              重试这一步
            </button>
          )}
        </div>
      )}
    </div>
  )
})
