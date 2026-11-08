import { memo, useEffect, useRef, useState } from 'react'
import type { TermShellKind } from '@shared/types'
import { store } from '../../store'

/**
 * 面板内嵌终端：主进程为会话维护一个持久 shell（保留 cd 状态与历史），
 * 输出经 term:event 流式推送。交互模式 = 在终端区域**直接输入**：
 * 输出末尾渲染行内块状光标，隐藏输入框接键入（IME / 粘贴 / ↑↓ 历史都走原生），
 * 回车整行写进 shell 并本地回显。组件常驻挂载（父级用 display 切换），切走再切回历史不丢。
 */

/** 渲染层保留的输出上限（字符），超出丢最旧的 */
const MAX_OUT_CHARS = 120_000

/** 管道输出里混着的 ANSI 控制序列全部剥掉，按纯文本渲染 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

function clip(s: string): string {
  return s.length > MAX_OUT_CHARS ? s.slice(s.length - MAX_OUT_CHARS) : s
}

const SHELL_LABELS: Record<TermShellKind, string> = {
  auto: '自动（默认）',
  pwsh: 'PowerShell 7',
  powershell: 'PowerShell 5.1',
  cmd: 'cmd',
  bash: 'bash'
}

/* ---------------- 终端主题（深色为主，符合终端直觉；localStorage 记忆） ---------------- */

interface TermTheme {
  label: string
  bg: string
  fg: string
  caret: string
}

const TERM_THEMES: Record<string, TermTheme> = {
  dark: { label: '深色', bg: '#1b1c1f', fg: '#e4e4e8', caret: '#e4e4e8' },
  oled: { label: '纯黑', bg: '#000000', fg: '#eaeaea', caret: '#ffffff' },
  navy: { label: '深蓝', bg: '#0d1b26', fg: '#c9dcea', caret: '#7ec3e8' },
  solarized: { label: 'Solarized', bg: '#002b36', fg: '#93a1a1', caret: '#eee8d5' },
  light: { label: '浅色', bg: '#fafafa', fg: '#242428', caret: '#242428' }
}

const FONT_SIZES: { label: string; px: number }[] = [
  { label: '小', px: 11 },
  { label: '中', px: 13 },
  { label: '大', px: 15 }
]

function loadThemeId(): string {
  const saved = localStorage.getItem('pi.termTheme')
  return saved && TERM_THEMES[saved] ? saved : 'dark'
}

function loadFontSize(): number {
  const saved = Number(localStorage.getItem('pi.termFontSize'))
  return FONT_SIZES.some((f) => f.px === saved) ? saved : 13
}

export const TerminalPane = memo(function TerminalPane({ sessionId }: { sessionId: string }): JSX.Element {
  const [out, setOut] = useState('')
  const [line, setLine] = useState('')
  const [alive, setAlive] = useState(true)
  const [shellKind, setShellKind] = useState<TermShellKind>('auto')
  const [themeId, setThemeId] = useState(loadThemeId)
  const [fontPx, setFontPx] = useState(loadFontSize)
  const theme = TERM_THEMES[themeId] ?? TERM_THEMES.dark
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const kindRef = useRef<TermShellKind>('auto')
  kindRef.current = shellKind
  /** 输入历史（↑↓ 回溯）；histIdx === length 表示正在编辑的草稿 */
  const historyRef = useRef<string[]>([])
  const histIdx = useRef(0)
  const draftRef = useRef('')

  useEffect(() => {
    let cancelled = false
    setOut('')
    setLine('')
    setAlive(true)
    historyRef.current = []
    histIdx.current = 0
    store
      .spawnTerm(sessionId, kindRef.current)
      .then((hist) => {
        if (!cancelled) setOut(clip(stripAnsi(hist)))
      })
      .catch((err) => {
        if (cancelled) return
        setAlive(false)
        setOut(`[终端启动失败：${(err as Error).message}]`)
      })
    const off = window.pi.onTermEvent((e) => {
      if (e.sessionId !== sessionId) return
      if (e.type === 'data') setOut((o) => clip(o + stripAnsi(e.data)))
      else setAlive(false)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [sessionId])

  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [out, line])

  const submit = (): void => {
    const cmd = line
    if (!cmd.trim() || !alive) return
    historyRef.current.push(cmd)
    histIdx.current = historyRef.current.length
    setLine('')
    // 管道无回显，命令行由本地补上
    setOut((o) => clip(`${o}${cmd}\n`))
    store.writeTerm(sessionId, cmd).catch((err) => {
      setAlive(false)
      store.notify('error', (err as Error).message)
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!alive) return
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!historyRef.current.length) return
      if (histIdx.current === historyRef.current.length) draftRef.current = line
      histIdx.current = Math.max(0, histIdx.current - 1)
      setLine(historyRef.current[histIdx.current] ?? '')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (histIdx.current >= historyRef.current.length) return
      histIdx.current += 1
      if (histIdx.current >= historyRef.current.length) {
        histIdx.current = historyRef.current.length
        setLine(draftRef.current)
      } else {
        setLine(historyRef.current[histIdx.current])
      }
      return
    }
    if (e.key === 'c' && e.ctrlKey) {
      // 管道模式下无法给运行中的命令发信号：Ctrl+C 语义 = 清空当前输入行
      e.preventDefault()
      setLine('')
    }
  }

  return (
    <div className="panel-pane">
      <div className="pane-toolbar">
        <select
          className="pane-select"
          value={shellKind}
          title="终端使用的 shell；自动 = 系统默认（Windows 优先 PowerShell 7）"
          onChange={(e) => void (async () => {
            const kind = e.target.value as TermShellKind
            setShellKind(kind)
            if (!alive) return
            await store.killTerm(sessionId)
            try {
              const hist = await store.spawnTerm(sessionId, kind)
              setAlive(true)
              setLine('')
              setOut(clip(stripAnsi(hist)))
            } catch (err) {
              setAlive(false)
              store.notify('error', (err as Error).message)
            }
          })()}
        >
          {(Object.keys(SHELL_LABELS) as TermShellKind[]).map((k) => (
            <option key={k} value={k}>
              {SHELL_LABELS[k]}
            </option>
          ))}
        </select>
        <select
          className="pane-select"
          value={themeId}
          title="终端配色"
          onChange={(e) => {
            setThemeId(e.target.value)
            localStorage.setItem('pi.termTheme', e.target.value)
          }}
        >
          {Object.entries(TERM_THEMES).map(([id, t]) => (
            <option key={id} value={id}>
              {t.label}
            </option>
          ))}
        </select>
        <select
          className="pane-select"
          value={fontPx}
          title="终端字号"
          onChange={(e) => {
            const px = Number(e.target.value)
            setFontPx(px)
            localStorage.setItem('pi.termFontSize', String(px))
          }}
        >
          {FONT_SIZES.map((f) => (
            <option key={f.px} value={f.px}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="pane-hint">{alive ? '点击终端直接输入 · ↑↓ 历史 · Ctrl+C 清行' : '已退出'}</span>
        <span className="pane-spacer" />
        <button className="pane-btn" type="button" title="关闭并重启终端" onClick={() => void (async () => {
          await store.killTerm(sessionId)
          try {
            const hist = await store.spawnTerm(sessionId, shellKind)
            setAlive(true)
            setLine('')
            setOut(clip(stripAnsi(hist)))
          } catch (err) {
            setAlive(false)
            store.notify('error', (err as Error).message)
          }
        })()}>
          重启
        </button>
      </div>
      <div className="term-wrap" onClick={() => inputRef.current?.focus()}>
        <div className="term-out" ref={bodyRef} style={{ background: theme.bg, color: theme.fg, fontSize: `${fontPx}px` }}>
          {out}
          {alive && (
            <span className="term-live">
              {line}
              <span className="term-caret" style={{ background: theme.caret }} />
            </span>
          )}
        </div>
        {/* 隐藏输入框：接键盘 / IME / 粘贴，视觉上只有输出区里的行内光标 */}
        <textarea
          ref={inputRef}
          className="term-hidden-input"
          value={line}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!alive}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="终端输入"
        />
        {!alive && (
          <div className="pane-overlay">
            <span>终端已退出</span>
            <button className="pane-btn" type="button" onClick={() => void (async () => {
              try {
                const hist = await store.spawnTerm(sessionId, shellKind)
                setAlive(true)
                setLine('')
                setOut(clip(stripAnsi(hist)))
              } catch (err) {
                store.notify('error', (err as Error).message)
              }
            })()}>
              重新打开
            </button>
          </div>
        )}
      </div>
    </div>
  )
})
