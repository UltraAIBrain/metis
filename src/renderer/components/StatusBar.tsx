import { memo, useState } from 'react'
import { lookupModel } from '@shared/model-catalog'
import { sessionModelOf, sessionProfileOf, store, useSlice } from '../store'

function totalTokens(messages: { role: string; usage?: { input: number; output: number } }[]): {
  input: number
  output: number
} {
  let input = 0
  let output = 0
  for (const m of messages) {
    if (m.role === 'assistant' && m.usage) {
      input += m.usage.input
      output += m.usage.output
    }
  }
  return { input, output }
}

function short(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 当前上下文占模型窗口的比例：以最近一次响应的 input tokens 为准（即下一次请求的基数） */
function contextPercent(session: { messages: { role: string; usage?: { input: number } }[] } | null, model: string): number | null {
  if (!session) return null
  const window = lookupModel(model)?.contextWindow
  if (!window) return null
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i]
    if (m.role === 'assistant' && m.usage?.input) {
      return Math.min(100, Math.round((m.usage.input / window) * 100))
    }
  }
  return null
}

export const StatusBar = memo(function StatusBar(): JSX.Element {
  const session = useSlice((s) => s.session)
  const runningIds = useSlice((s) => s.runningIds)
  const queue = useSlice((s) => s.queue)
  const config = useSlice((s) => s.config)
  const [compacting, setCompacting] = useState(false)

  const id = session?.id
  const running = Boolean(id && runningIds.includes(id))
  const queued = id ? queue[id]?.length ?? 0 : 0
  const tokens = totalTokens(session?.messages ?? [])
  const steps = session?.messages.filter((m) => m.role === 'assistant').length ?? 0
  const profile = sessionProfileOf({ session, config })
  const provider = profile?.label ?? '未配置提供商'
  const model = sessionModelOf({ session, config }) || '—'
  const used = contextPercent(session ?? null, model)

  const label = running ? (queued ? `运行中 · 排队 ${queued}` : '运行中') : '就绪'

  const compact = async (): Promise<void> => {
    if (!session || session.id === 'draft' || compacting) return
    setCompacting(true)
    try {
      await store.compactSession(session.id)
    } catch (err) {
      store.notify('error', `压缩失败：${(err as Error).message}`)
    } finally {
      setCompacting(false)
    }
  }

  return (
    <footer className="statusbar">
      <span className={`status-dot ${running ? 'busy' : ''}`} />
      <span className="status-label">{label}</span>
      <span className="status-sep" />
      <span className="status-path" title={session?.cwd ?? ''}>
        {session?.cwd || (session ? '项目目录将在首次运行时自动创建' : '没有打开的项目')}
      </span>
      <span className="status-spacer" />
      {used !== null && session && session.id !== 'draft' && (
        <>
          <span
            className={`status-ctx ${used >= 90 ? 'hot' : used >= 75 ? 'warn' : ''}`}
            title="最近一次请求的输入占模型上下文窗口的比例；接近上限时压缩上下文"
          >
            上下文 {used}%
          </span>
          {(used >= 60 || compacting) && (
            <button
              className="statusbar-btn"
              type="button"
              disabled={running || compacting}
              title="把当前分支总结成摘要，切到摘要新分支继续（原分支完整保留，可随时切回）"
              onClick={() => void compact()}
            >
              {compacting ? '压缩中…' : '压缩上下文'}
            </button>
          )}
          <span className="status-sep" />
        </>
      )}
      {tokens.input + tokens.output > 0 && (
        <span className="status-tokens" title="本会话累计：模型响应步数与 token 用量">
          {steps} 步 · ↑{short(tokens.input)} ↓{short(tokens.output)}
        </span>
      )}
      <span className="status-model" title={`${provider} · ${model}`}>
        {provider} · {model}
      </span>
    </footer>
  )
})
