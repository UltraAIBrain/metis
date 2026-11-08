import { memo, useState } from 'react'
import { store, useSlice, type PendingQuestion } from '../store'

/** ask 工具的结构化提问卡片：点选一个候选，或展开输入框自行回答 */
export const AskDialog = memo(function AskDialog(): JSX.Element | null {
  const ask = useSlice((s) => s.askQueue[0])
  return ask ? <Question key={`${ask.sessionId}:${ask.callId}`} ask={ask} /> : null
})

function Question({ ask }: { ask: PendingQuestion }): JSX.Element {
  const [other, setOther] = useState('')
  const [showOther, setShowOther] = useState(false)
  const [answering, setAnswering] = useState(false)
  const title = useSlice((s) => s.sessions.find((session) => session.id === ask.sessionId)?.title)

  const answer = (choice: number, text = ''): void => {
    if (answering) return
    setAnswering(true)
    void store.answerAsk(ask.sessionId, ask.callId, choice, text).finally(() => setAnswering(false))
  }

  return (
    <div className="overlay ask-overlay">
      <div className="dialog ask-dialog" role="dialog" aria-modal="true">
        <div className="ask-title">{title ? `${title} · ` : ''}模型需要你确认</div>
        <p className="ask-question">{ask.question}</p>
        <div className="ask-options">
          {ask.options.map((opt, i) => (
            <button
              key={i}
              type="button"
              className="ask-option"
              disabled={answering}
              onClick={() => answer(i, opt)}
              title={opt}
            >
              <span className="ask-option-no">{String.fromCharCode(65 + i)}</span>
              <span className="ask-option-text">{opt}</span>
            </button>
          ))}
        </div>
        {showOther ? (
          <div className="ask-other-row">
            <input
              autoFocus
              value={other}
              disabled={answering}
              placeholder="输入你的回答，回车提交"
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && other.trim()) answer(-1, other)
                if (e.key === 'Escape') setShowOther(false)
              }}
            />
          </div>
        ) : (
          <button className="ask-other-btn" type="button" disabled={answering} onClick={() => setShowOther(true)}>
            其他…（自行输入）
          </button>
        )}
      </div>
    </div>
  )
}
