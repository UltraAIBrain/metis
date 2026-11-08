import { memo, useMemo, useState, type ReactNode } from 'react'
import { chartGeometry, linePath, parseChartSpec, type ChartSpec } from '@shared/chart'

/* ------------------------------------------------------------------
   Markdown 渲染：块级解析 + 行内解析，全部产出 React 元素（不用 innerHTML）。
   覆盖：标题、列表（含嵌套）、引用、代码块、表格、分隔线、链接、图片、
        粗体 / 斜体 / 删除线 / 行内代码。
------------------------------------------------------------------- */

type Align = 'left' | 'center' | 'right' | null

type Block =
  | { kind: 'code'; lang: string; text: string; open: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: { depth: number; text: string }[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; align: Align[]; head: string[]; rows: string[][] }
  | { kind: 'hr' }

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const HR = /^\s{0,3}(?:-[ \t]*-[ \t]*-[-\s]*|\*[ \t]*\*[ \t]*\*[\s*]*|_[ \t]*_[ \t]*_[\s_]*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const UL = /^(\s*)([-*+])[ \t]+(.*)$/
const OL = /^(\s*)(\d+)[.)][ \t]+(.*)$/
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

function isTableStart(line: string | undefined, next: string | undefined): boolean {
  return Boolean(line && line.includes('|') && next && TABLE_SEP.test(next) && next.includes('|'))
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    // 代码块（含流式未闭合的情况）
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      const lang = fence[2] ?? ''
      const body: string[] = []
      i++
      let open = true
      while (i < lines.length) {
        const cur = lines[i].trim()
        if (cur.startsWith(marker) && cur.replace(/[`~]/g, '') === '') {
          open = false
          i++
          break
        }
        body.push(lines[i])
        i++
      }
      blocks.push({ kind: 'code', lang, text: body.join('\n'), open })
      continue
    }

    // 标题
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    // 分隔线
    if (line.trim().length >= 3 && HR.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }

    // 表格
    if (isTableStart(line, lines[i + 1])) {
      const head = cells(line)
      const align: Align[] = cells(lines[i + 1]).map((c) => {
        const left = c.startsWith(':')
        const right = c.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        if (left) return 'left'
        return null
      })
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(cells(lines[i]))
        i++
      }
      blocks.push({ kind: 'table', align, head, rows })
      continue
    }

    // 引用
    if (QUOTE.test(line)) {
      const buf: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(QUOTE.exec(lines[i])![1])
        i++
      }
      blocks.push({ kind: 'quote', text: buf.join('\n') })
      continue
    }

    // 列表（有序 / 无序，按缩进分层）
    const ul = UL.exec(line)
    const ol = OL.exec(line)
    if (ul || ol) {
      const ordered = Boolean(ol)
      const start = ol ? Number(ol[2]) : 1
      const items: { depth: number; text: string }[] = []
      while (i < lines.length) {
        const cur = lines[i]
        const m = ordered ? OL.exec(cur) : UL.exec(cur)
        if (!m) {
          // 空行后仍是同类列表就继续，否则收尾
          if (!cur.trim() && lines[i + 1] && (ordered ? OL.test(lines[i + 1]) : UL.test(lines[i + 1]))) {
            i++
            continue
          }
          break
        }
        const indent = m[1].replace(/\t/g, '  ').length
        items.push({ depth: Math.min(3, Math.floor(indent / 2)), text: m[3] })
        i++
      }
      blocks.push({ kind: 'list', ordered, start, items })
      continue
    }

    // 段落：吃到空行为止
    const buf: string[] = []
    while (i < lines.length && lines[i].trim()) {
      const cur = lines[i]
      if (
        FENCE.test(cur) ||
        HEADING.test(cur) ||
        QUOTE.test(cur) ||
        UL.test(cur) ||
        OL.test(cur) ||
        isTableStart(cur, lines[i + 1]) ||
        (cur.trim().length >= 3 && HR.test(cur))
      ) {
        break
      }
      buf.push(cur)
      i++
    }
    if (buf.length) blocks.push({ kind: 'para', text: buf.join('\n') })
    else i++ // 兜底，避免死循环
  }

  return blocks
}

/* ------------------------------ 行内 ------------------------------ */

const SAFE_HREF = /^(https?:\/\/|mailto:)/i

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|((?<![A-Za-z0-9])_[^_\n]+_(?![A-Za-z0-9]))|(!?\[[^\]\n]*\]\([^)\s]+\))|(<(?:https?:\/\/|mailto:)[^>\s]+>)/g

function toNodes(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0

  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]

    if (token.startsWith('`')) {
      out.push(
        <code key={key++} className="inline-code">
          {token.slice(1, -1)}
        </code>
      )
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('~~')) {
      out.push(<del key={key++}>{token.slice(2, -2)}</del>)
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>)
    } else if (token.startsWith('<')) {
      const url = token.slice(1, -1)
      out.push(
        <a key={key++} href={url} target="_blank" rel="noreferrer">
          {url}
        </a>
      )
    } else {
      // ![alt](url) 或 [text](url)
      const image = token.startsWith('!')
      const label = /\[([^\]]*)\]/.exec(token)?.[1] ?? ''
      const raw = /\(([^)\s]+)\)/.exec(token)?.[1] ?? ''
      if (SAFE_HREF.test(raw)) {
        out.push(
          image ? (
            <a key={key++} href={raw} target="_blank" rel="noreferrer">
              {label ? `图片：${label}` : raw}
            </a>
          ) : (
            <a key={key++} href={raw} target="_blank" rel="noreferrer">
              {label || raw}
            </a>
          )
        )
      } else {
        // 不安全的协议（javascript: 等）按纯文本显示
        out.push(token)
      }
    }

    last = m.index + token.length
  }

  if (last < text.length) out.push(text.slice(last))
  return out
}

function Inline({ text }: { text: string }): JSX.Element {
  return <>{toNodes(text)}</>
}

/* ------------------------------ 组件 ------------------------------ */

/** Gen UI 轻量版：```chart 围栏（JSON）→ 内联 SVG 图表（bar/line） */
function ChartView({ spec }: { spec: ChartSpec }): JSX.Element {
  const geo = chartGeometry(spec)
  const gridLines = [0, 0.5, 1].map((f) => geo.height - 10 - f * (geo.height - 20))
  const fmt = (v: number): string => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v * 100) / 100))
  return (
    <div className="md-chart">
      {spec.title && <div className="md-chart-title">{spec.title}</div>}
      <svg viewBox={`0 0 ${geo.width} ${geo.height}`} role="img" aria-label={spec.title || '图表'}>
        {gridLines.map((y) => (
          <line key={y} x1="10" x2={geo.width - 10} y1={y} y2={y} className="md-chart-grid" />
        ))}
        {spec.type === 'line' ? (
          <>
            <path d={linePath(geo.points)} className="md-chart-line" fill="none" />
            {geo.points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r="2.6" className="md-chart-dot">
                <title>{`${spec.labels[i] ?? i + 1}: ${spec.values[i]}`}</title>
              </circle>
            ))}
          </>
        ) : (
          geo.bars.map((b, i) => (
            <rect key={i} x={b.x} y={b.y} width={b.width} height={Math.max(b.height, 1)} rx="2" className="md-chart-bar">
              <title>{`${spec.labels[i] ?? i + 1}: ${spec.values[i]}`}</title>
            </rect>
          ))
        )}
        <text x="10" y="12" className="md-chart-max">{fmt(geo.max)}</text>
        <text x="10" y={geo.height - 2} className="md-chart-min">{fmt(geo.min)}</text>
      </svg>
      <div className="md-chart-labels">
        {spec.labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </div>
  )
}

function CodeBlock({ text, lang, open }: { text: string; lang: string; open: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">
          {lang || 'text'}
          {open && <span className="code-streaming"> · 生成中</span>}
        </span>
        <button className="code-copy" onClick={copy} type="button">
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  )
}

function BlockView({ block }: { block: Block }): JSX.Element {
  switch (block.kind) {
    case 'code':
      // Gen UI 轻量版：```chart 围栏（JSON 数据）渲染成内联 SVG；解析失败/流式中回退代码块
      if (block.lang === 'chart' && !block.open) {
        const spec = parseChartSpec(block.text)
        if (spec) return <ChartView spec={spec} />
      }
      return <CodeBlock text={block.text} lang={block.lang} open={block.open} />
    case 'heading': {
      const Tag = `h${block.level}` as 'h1'
      return (
        <Tag className="md-h">
          <Inline text={block.text} />
        </Tag>
      )
    }
    case 'hr':
      return <hr className="md-hr" />
    case 'quote':
      return (
        <blockquote className="md-quote">
          <Inline text={block.text} />
        </blockquote>
      )
    case 'para':
      return (
        <p className="md-p">
          <Inline text={block.text} />
        </p>
      )
    case 'list':
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {block.items.map((it, i) => (
            <li key={i} className={it.depth > 0 ? 'md-nested' : ''} style={{ marginLeft: it.depth * 16 }}>
              <Inline text={it.text} />
            </li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {block.items.map((it, i) => (
            <li key={i} className={it.depth > 0 ? 'md-nested' : ''} style={{ marginLeft: it.depth * 16 }}>
              <Inline text={it.text} />
            </li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((c, i) => (
                  <th key={i} style={{ textAlign: block.align[i] ?? undefined }}>
                    <Inline text={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci} style={{ textAlign: block.align[ci] ?? undefined }}>
                      <Inline text={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

/** memo：流式输出时历史消息的 text 不变，跳过重复的全文解析 */
export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <div className="md">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  )
})
