import { memo, useState } from 'react'
import type { ToolMessage } from '@shared/types'
import { DiffView } from './DiffView'

function Icon({ name }: { name: string }): JSX.Element {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }
  if (name === 'read') {
    return (
      <svg {...common}>
        <path d="M3 2.5h6l3 3v8h-9z" strokeLinejoin="round" />
        <path d="M5 7h5M5 9.5h5M5 12h3" strokeLinecap="round" />
      </svg>
    )
  }
  if (name === 'write') {
    return (
      <svg {...common}>
        <path d="M8 2.5v7M5 6.5l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 13.5h10" strokeLinecap="round" />
      </svg>
    )
  }
  if (name === 'edit') {
    return (
      <svg {...common}>
        <path d="M10.5 2.5l3 3-7 7-3.5.5.5-3.5z" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M3.5 4l3 4-3 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.5 12.5h4" strokeLinecap="round" />
    </svg>
  )
}

function basename(p: unknown): string {
  if (typeof p !== 'string') return ''
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function summarize(m: ToolMessage): string {
  const input = m.input ?? {}
  const path = typeof input.path === 'string' ? input.path : basename(input.path)

  if (m.meta?.kind === 'bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    return cmd.split('\n')[0].slice(0, 90)
  }
  if (m.meta?.kind === 'read') return `${m.meta.path} · ${m.meta.startLine}-${m.meta.endLine} 行`
  if (m.meta?.kind === 'write') return `${m.meta.path} · ${m.meta.created ? '新建' : '覆盖'}`
  if (m.meta?.kind === 'edit') return `${m.meta.path} · +${m.meta.additions} −${m.meta.removals}`
  if (m.meta?.kind === 'task') {
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    return prompt.split('\n')[0].slice(0, 90) || m.meta.label
  }
  return path
}

function shortTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function duration(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export const ToolCard = memo(function ToolCard({ message }: { message: ToolMessage }): JSX.Element {
  const meta = message.meta
  const [open, setOpen] = useState<boolean>(meta?.kind === 'edit' && !message.isError)
  const status = message.isError ? 'error' : 'ok'

  return (
    <div className={`tool-card ${open ? 'open' : ''} ${status}`}>
      <button className="tool-head" type="button" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-icon ${status}`}>
          <Icon name={message.name} />
        </span>
        <span className="tool-name">{message.name}</span>
        <span className="tool-summary" title={summarize(message)}>
          {summarize(message)}
        </span>
        <span className="tool-right">
          {meta?.kind === 'bash' && (
            <span className={`exit-badge ${meta.exitCode === 0 ? 'ok' : 'err'}`}>
              {meta.timedOut ? 'timeout' : `exit ${meta.exitCode ?? '—'}`}
            </span>
          )}
          {meta?.kind === 'task' && (
            <span
              className={`exit-badge ${message.isError ? 'err' : 'ok'}`}
              title={`${meta.steps} 步 · in ${shortTokens(meta.inputTokens)} / out ${shortTokens(meta.outputTokens)} · ${duration(meta.durationMs)}`}
            >
              {meta.steps} 步
            </span>
          )}
          {message.isError && <span className="exit-badge err">失败</span>}
          <svg
            className="chevron"
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M5 6l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>

      {open && (
        <div className="tool-body">
          {meta?.kind === 'edit' ? (
            <DiffView diff={meta.diff} />
          ) : meta?.kind === 'write' ? (
            <div className="tool-note">{message.content}</div>
          ) : (
            <pre className={`tool-output ${status}`}>{message.content}</pre>
          )}
          {meta?.kind === 'bash' && meta.truncated && (
            <div className="tool-note">输出已截断，仅保留前 200KB。</div>
          )}
        </div>
      )}
    </div>
  )
})
