import { memo, useEffect, useRef, useState } from 'react'
import type { Trajectory, TrajectoryTurn } from '@shared/types'
import { store } from '../../store'

/**
 * 面板内轨迹检查器：把会话聚合成「回合 → 模型响应 → 工具往返」的线性结构，
 * 每步带参数摘要 / 结果 / 耗时 / 成败——数据来自主进程 buildTrajectory（当前分支）。
 */

function short(s: string, n = 60): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

function argOf(step: { input?: Record<string, unknown> }): string {
  const input = step.input ?? {}
  if (typeof input.command === 'string') return short(input.command)
  if (typeof input.path === 'string') return String(input.path)
  if (typeof input.prompt === 'string') return short(input.prompt, 48)
  return ''
}

function dur(ms?: number): string {
  if (!ms || ms < 0) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function TurnCard({ turn, index }: { turn: TrajectoryTurn; index: number }): JSX.Element {
  const [open, setOpen] = useState(index === 0)
  const title = short(turn.userText, 80) || '（空消息）'
  return (
    <div className="trace-turn">
      <button className="trace-turn-head" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="trace-turn-no">#{index + 1}</span>
        <span className="trace-turn-title" title={turn.userText}>
          {title}
        </span>
        <span className="trace-turn-stats">
          {turn.steps} 步{turn.inputTokens + turn.outputTokens > 0 ? ` · ${(turn.inputTokens / 1000).toFixed(1)}k/${(turn.outputTokens / 1000).toFixed(1)}k` : ''}
        </span>
        <svg className={`chevron ${open ? 'open' : ''}`} width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M5 6l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="trace-turn-body">
          {turn.responses.map((r) => (
            <div key={r.assistantId} className="trace-response">
              {r.text && <div className="trace-text">{short(r.text, 400)}</div>}
              {r.error && <div className="trace-error">出错：{short(r.error, 160)}</div>}
              {r.toolCalls.map((t) => (
                <details key={t.toolCallId} className={`trace-step ${t.isError ? 'err' : ''}`}>
                  <summary>
                    <span className={`trace-step-mark ${t.isError ? 'err' : ''}`}>{t.isError ? '✗' : '✓'}</span>
                    <span className="trace-step-name">{t.name}</span>
                    <span className="trace-step-arg">{argOf(t)}</span>
                    {t.durationMs !== undefined && <span className="trace-step-dur">{dur(t.durationMs)}</span>}
                  </summary>
                  <div className="trace-step-io">
                    <div className="trace-io-row">
                      <i>参数</i>
                      <pre>{JSON.stringify(t.input ?? {}, null, 2).slice(0, 1200)}</pre>
                    </div>
                    <div className="trace-io-row">
                      <i>结果</i>
                      <pre>{t.content.slice(0, 2000) || '（空）'}</pre>
                    </div>
                  </div>
                </details>
              ))}
              {r.usage && (
                <div className="trace-usage">
                  {r.model} · ↑{r.usage.input} ↓{r.usage.output} · {dur(r.durationMs)}
                </div>
              )}
            </div>
          ))}
          {!turn.responses.length && <div className="panel-empty">本回合没有模型响应</div>}
        </div>
      )}
    </div>
  )
}

export const TracePane = memo(function TracePane({ sessionId }: { sessionId: string }): JSX.Element {
  const [data, setData] = useState<Trajectory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)

  const load = async (): Promise<void> => {
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const traj = await store.trajectoryData(sessionId)
      if (request !== requestRef.current) return
      setData(traj)
    } catch (err) {
      if (request !== requestRef.current) return
      setError((err as Error).message)
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return (
    <div className="panel-pane trace-pane">
      <div className="panel-view-head">
        <span>
          轨迹
          {data ? `（${data.totals.turns} 回合 · ${data.totals.steps} 步）` : ''}
        </span>
        <button
          className="panel-refresh"
          type="button"
          title="刷新"
          disabled={loading}
          onClick={() => void load()}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M13.5 8a5.5 5.5 0 11-1.6-3.9" strokeLinecap="round" />
            <path d="M13.7 1.8v2.7h-2.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {loading ? (
        <div className="panel-empty">读取中…</div>
      ) : error ? (
        <div className="panel-empty">{error}</div>
      ) : !data || !data.turns.length ? (
        <div className="panel-empty">还没有运行轨迹：发一条消息开始</div>
      ) : (
        <div className="trace-list">
          {data.turns.map((t, i) => (
            <TurnCard key={t.userId} turn={t} index={i} />
          ))}
        </div>
      )}
    </div>
  )
})
