import { existsSync, readFileSync, statSync } from 'node:fs'
import { paths } from './paths'
import { tokenize } from './agent/memory-store'
import type { SessionSummary } from '@shared/types'

/**
 * 跨会话检索：拿查询的分词去扫最近 N 个会话的 JSONL，按消息命中打分。
 * 数据本来就是纯文本 JSONL，直接线性扫（50 会话 × 200KB 封顶 ≈ 十几毫秒级），
 * 不值得为这个量级引入索引文件。
 */

export interface SessionSearchHit {
  sessionId: string
  /** 会话标题 */
  title: string
  /** 消息 id（未来可做"跳到那条消息"） */
  messageId: string
  role: string
  /** 命中行预览（截断） */
  snippet: string
  ts: number
  score: number
}

const MAX_SESSIONS = 50
const MAX_FILE_CHARS = 200_000
const MAX_HITS = 20
const SNIPPET = 120

export function searchSessions(query: string, sessions: SessionSummary[]): SessionSearchHit[] {
  const q = query.trim()
  if (!q) return []
  const queryTokens = [...new Set(tokenize(q))]
  if (!queryTokens.length) return []

  const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS)
  const hits: SessionSearchHit[] = []

  for (const summary of recent) {
    const file = `${paths.sessions()}/${assertId(summary.id)}.jsonl`
    if (!existsSync(file)) continue
    let raw = ''
    try {
      raw = statSync(file).size > MAX_FILE_CHARS ? readFileSync(file, 'utf8').slice(-MAX_FILE_CHARS) : readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let role = ''
      let id = ''
      let ts = 0
      let text = ''
      try {
        const entry = JSON.parse(trimmed) as { message?: { role?: string; id?: string; ts?: number; text?: string; content?: string; blocks?: { text?: string }[] } }
        const m = entry.message
        if (!m) continue
        role = String(m.role ?? '')
        id = String(m.id ?? '')
        ts = Number(m.ts ?? 0)
        if (typeof m.text === 'string') text = m.text
        else if (typeof m.content === 'string') text = m.content
        else if (Array.isArray(m.blocks)) text = m.blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join(' ')
      } catch {
        continue
      }
      if (!text) continue
      const tokens = new Set(tokenize(text))
      let score = 0
      for (const t of queryTokens) if (tokens.has(t)) score += 1
      if (score < Math.max(2, Math.ceil(queryTokens.length / 2))) continue // 至少命中一半查询词
      const lower = text.toLowerCase()
      const idx = lower.indexOf(queryTokens[0])
      const snippet = (idx >= 0 ? text.slice(Math.max(0, idx - 30), idx + SNIPPET) : text.slice(0, SNIPPET)).replace(/\s+/g, ' ').trim()
      hits.push({ sessionId: summary.id, title: summary.title || '未命名会话', messageId: id, role, snippet, ts, score })
      if (hits.length >= 400) break
    }
    if (hits.length >= 400) break
  }

  hits.sort((a, b) => b.score - a.score || b.ts - a.ts)
  const seen = new Set<string>()
  const out: SessionSearchHit[] = []
  for (const h of hits) {
    // 同一会话最多出 4 条，避免一个会话刷屏
    const count = [...out].filter((x) => x.sessionId === h.sessionId).length
    if (count >= 4) continue
    seen.add(h.messageId)
    out.push(h)
    if (out.length >= MAX_HITS) break
  }
  return out
}

function assertId(raw: string): string {
  // search 只读，不复用 assertSessionId 抛错路径：脏 id 直接跳过
  return /^[a-z0-9_]+$/i.test(raw) ? raw : ''
}
