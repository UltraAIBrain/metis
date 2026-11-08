import { memo, useState } from 'react'
import { store, useSlice } from '../store'

/** ask 工具的结构化提问卡片：点选一个候选，或展开输入框自行回答 */
export const AskDialog = memo(function AskDialog(): JSX.Element | null {
  const ask = useSlice((s) => s.askDialog)
  const [other, setOther] = useState('')
  const [showOther, setShowOther] = useState(false)
  if (!ask) return null

  const answer = (choice: number, text = ''): void => void store.answerAsk(ask.callId, choice, text)

  return (
    <div className="overlay ask-overlay">
      <div className="dialog ask-dialog" role="dialog" aria-modal="true">
        <div className="ask-title">模型需要你确认</div>
        <p className="ask-question">{ask.question}</p>
        <div className="ask-options">
          {ask.options.map((opt, i) => (
            <button
              key={i}
              type="button"
              className="ask-option"
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
              placeholder="输入你的回答，回车提交"
              onChange={(e) => setOther(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && other.trim()) answer(-1, other)
                if (e.key === 'Escape') setShowOther(false)
              }}
            />
          </div>
        ) : (
          <button className="ask-other-btn" type="button" onClick={() => setShowOther(true)}>
            其他…（自行输入）
          </button>
        )}
      </div>
    </div>
  )
})
