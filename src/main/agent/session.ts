import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths'
import type { BranchInfo, Message, SessionSummary, SessionView, ThinkingEffort } from '@shared/types'

export interface SessionEntry {
  type: 'message'
  id: string
  parentId: string | null
  ts: number
  message: Message
}

export interface SessionMeta {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  leafId: string | null
  entryCount: number
  /** 会话级模型选择：为空时沿用全局默认 */
  profileId?: string
  model?: string
  /** 会话级思考强度：为空时沿用全局默认 */
  thinking?: ThinkingEffort
  /** 置顶：排序时优先，不受最近更新时间影响 */
  pinned?: boolean
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** 会话的子任务过程记录文件（不进 SessionStore 是因为它不是会话数据，只是附属回放材料） */
export function subagentsFile(sessionId: string): string {
  return paths.subagents(assertSessionId(sessionId))
}

export function assertSessionId(raw: unknown): string {
  const id = String(raw ?? '')
  if (!/^s_[a-z0-9]+$/i.test(id)) throw new Error('无效的会话 ID')
  return id
}

function deriveTitle(messages: Message[]): string {
  const first = messages.find((m) => m.role === 'user') as { text: string } | undefined
  if (!first) return ''
  const line = first.text.replace(/\s+/g, ' ').trim()
  return line.length > 46 ? `${line.slice(0, 46)}…` : line
}

interface StatSnapshot {
  mtimeMs: number
  size: number
}

interface EntriesCache {
  stat: StatSnapshot
  entries: SessionEntry[]
}

interface MetaCache {
  stat: StatSnapshot
  meta: SessionMeta
}

/**
 * 会话存储：每个会话一个 JSONL 追加文件 + 一个 meta 文件。
 * 每条消息记录 parentId，因此天然支持树形分支（pi 的核心特性）：
 * 切换 leaf 就能回到任意历史点继续，旧分支不会被覆盖。
 *
 * meta 与 entries 带进程内缓存，以 mtime + size 校验是否失效：
 * 一次运行里每条消息都要读全量历史，不缓存的话长会话会反复解析整个 JSONL。
 */
export class SessionStore {
  private entriesCache = new Map<string, EntriesCache>()
  private metaCache = new Map<string, MetaCache>()

  constructor(private root: string) {
    mkdirSync(root, { recursive: true })
  }

  private statOf(file: string): StatSnapshot {
    const st = statSync(file)
    return { mtimeMs: st.mtimeMs, size: st.size }
  }

  private jsonl(id: string): string {
    return join(this.root, `${assertSessionId(id)}.jsonl`)
  }

  private metaFile(id: string): string {
    return join(this.root, `${assertSessionId(id)}.meta.json`)
  }

  list(): SessionSummary[] {
    if (!existsSync(this.root)) return []
    const out: SessionSummary[] = []
    for (const file of readdirSync(this.root)) {
      if (!file.endsWith('.meta.json')) continue
      try {
        const meta = this.meta(file.slice(0, -'.meta.json'.length))
        out.push({
          id: meta.id,
          title: meta.title || '未命名会话',
          cwd: meta.cwd,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          messageCount: meta.entryCount ?? 0,
          pinned: meta.pinned === true
        })
      } catch {
        /* 损坏的 meta 直接跳过，不影响其他会话 */
      }
    }
    // 置顶优先，其余按最近更新
    return out.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
  }

  create(cwd: string, preset?: { profileId?: string; model?: string }): SessionMeta {
    const meta: SessionMeta = {
      id: newId('s'),
      title: '',
      cwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      leafId: null,
      entryCount: 0,
      profileId: preset?.profileId,
      model: preset?.model
    }
    writeFileSync(this.jsonl(meta.id), '', 'utf8')
    this.writeMeta(meta)
    return meta
  }

  /** 会话是否已经开始（有过任何一条消息）。开始后目录就锁定了。 */
  hasStarted(sessionId: string): boolean {
    return (this.meta(sessionId).entryCount ?? 0) > 0
  }

  /** 修改会话绑定的提供商与模型；只影响这个会话之后的请求。 */
  setModel(sessionId: string, profileId: string, model: string): void {
    const meta = this.meta(sessionId)
    meta.profileId = profileId || undefined
    meta.model = model.trim() || undefined
    this.writeMeta(meta)
  }

  /** 置顶 / 取消置顶 */
  setPinned(sessionId: string, pinned: boolean): void {
    const meta = this.meta(sessionId)
    meta.pinned = pinned || undefined
    this.writeMeta(meta)
  }

  /** 修改会话的思考强度；只影响这个会话之后的请求。 */
  setThinking(sessionId: string, thinking: ThinkingEffort | undefined): void {
    const meta = this.meta(sessionId)
    meta.thinking = thinking
    this.writeMeta(meta)
  }

  exists(id: string): boolean {
    return existsSync(this.metaFile(id))
  }

  meta(id: string): SessionMeta {
    const file = this.metaFile(id)
    const st = this.statOf(file)
    const cached = this.metaCache.get(id)
    if (cached && cached.stat.mtimeMs === st.mtimeMs && cached.stat.size === st.size) return cached.meta
    const meta = JSON.parse(readFileSync(file, 'utf8')) as SessionMeta
    if (meta.id !== id) throw new Error('会话元数据 ID 不一致')
    this.metaCache.set(id, { stat: st, meta })
    return meta
  }

  entries(id: string): SessionEntry[] {
    const file = this.jsonl(id)
    if (!existsSync(file)) {
      this.entriesCache.delete(id)
      return []
    }
    const st = this.statOf(file)
    const cached = this.entriesCache.get(id)
    if (cached && cached.stat.mtimeMs === st.mtimeMs && cached.stat.size === st.size) return cached.entries
    const raw = readFileSync(file, 'utf8')
    const out: SessionEntry[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const entry = JSON.parse(trimmed) as SessionEntry
        if (entry?.type === 'message' && entry.message) out.push(entry)
      } catch {
        /* 单行损坏不影响其余历史 */
      }
    }
    this.entriesCache.set(id, { stat: st, entries: out })
    return out
  }

  append(sessionId: string, message: Message): SessionEntry {
    const meta = this.meta(sessionId)
    const entry: SessionEntry = {
      type: 'message',
      id: message.id,
      parentId: meta.leafId,
      ts: message.ts,
      message
    }
    appendFileSync(this.jsonl(sessionId), `${JSON.stringify(entry)}\n`, 'utf8')
    const cachedEntries = this.entriesCache.get(sessionId)
    if (cachedEntries) {
      cachedEntries.entries.push(entry)
      cachedEntries.stat = this.statOf(this.jsonl(sessionId))
    }
    meta.leafId = message.id
    meta.entryCount = (meta.entryCount ?? 0) + 1
    meta.updatedAt = Date.now()
    if (!meta.title) {
      const title = deriveTitle(this.pathMessages(meta, this.entries(sessionId)))
      if (title) meta.title = title
    }
    this.writeMeta(meta)
    return entry
  }

  setLeaf(sessionId: string, leafId: string | null): void {
    const meta = this.meta(sessionId)
    if (leafId && !this.entries(sessionId).some((e) => e.id === leafId)) return
    meta.leafId = leafId
    meta.updatedAt = Date.now()
    this.writeMeta(meta)
  }

  /**
   * 追加一个"新根"条目（parentId = null）并把当前分支切过去——上下文压缩专用：
   * 摘要成为独立分支的起点，原对话分支原样保留，可用分支切换回到旧根。
   */
  appendRoot(sessionId: string, message: Message): SessionEntry {
    const meta = this.meta(sessionId)
    const entry: SessionEntry = {
      type: 'message',
      id: message.id,
      parentId: null,
      ts: message.ts,
      message
    }
    appendFileSync(this.jsonl(sessionId), `${JSON.stringify(entry)}\n`, 'utf8')
    const cachedEntries = this.entriesCache.get(sessionId)
    if (cachedEntries) {
      cachedEntries.entries.push(entry)
      cachedEntries.stat = this.statOf(this.jsonl(sessionId))
    }
    meta.leafId = message.id
    meta.entryCount = (meta.entryCount ?? 0) + 1
    meta.updatedAt = Date.now()
    this.writeMeta(meta)
    return entry
  }

  rename(sessionId: string, title: string): void {
    const meta = this.meta(sessionId)
    meta.title = title.trim().slice(0, 80) || deriveTitle(this.pathMessages(meta, this.entries(sessionId))) || '未命名会话'
    meta.updatedAt = Date.now()
    this.writeMeta(meta)
  }

  remove(sessionId: string): void {
    for (const f of [this.jsonl(sessionId), this.metaFile(sessionId), subagentsFile(sessionId)]) {
      if (existsSync(f)) rmSync(f, { force: true })
    }
    this.entriesCache.delete(sessionId)
    this.metaCache.delete(sessionId)
  }

  view(sessionId: string): SessionView {
    const meta = this.meta(sessionId)
    const entries = this.entries(sessionId)
    const byId = new Map(entries.map((e) => [e.id, e]))
    const path = this.pathEntries(meta.leafId, byId)

    const children = new Map<string | null, SessionEntry[]>()
    for (const e of entries) {
      const list = children.get(e.parentId) ?? []
      list.push(e)
      children.set(e.parentId, list)
    }
    for (const list of children.values()) list.sort((a, b) => a.ts - b.ts)

    const branch: Record<string, BranchInfo> = {}
    for (const e of path) {
      const siblings = children.get(e.parentId) ?? [e]
      if (siblings.length > 1) {
        branch[e.id] = { index: siblings.findIndex((s) => s.id === e.id), count: siblings.length }
      }
    }

    return {
      id: meta.id,
      title: meta.title || deriveTitle(path.map((e) => e.message)) || '新会话',
      cwd: meta.cwd,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      leafId: meta.leafId,
      profileId: meta.profileId,
      model: meta.model,
      thinking: meta.thinking,
      messages: path.map((e) => e.message),
      branch
    }
  }

  /** 切换某条消息的兄弟分支，并把 leaf 落到目标分支的最深处。 */
  switchBranch(sessionId: string, entryId: string, direction: -1 | 1): SessionView {
    const entries = this.entries(sessionId)
    const target = entries.find((e) => e.id === entryId)
    if (target) {
      const siblings = entries.filter((e) => e.parentId === target.parentId).sort((a, b) => a.ts - b.ts)
      const idx = siblings.findIndex((s) => s.id === entryId)
      const next = siblings[idx + direction]
      if (next) this.setLeaf(sessionId, this.deepestLeaf(next.id, entries))
    }
    return this.view(sessionId)
  }

  fork(sessionId: string, messageId: string): SessionView {
    this.setLeaf(sessionId, messageId)
    return this.view(sessionId)
  }

  /** 在编辑器中切换工作目录后，同步会话 cwd。 */
  setCwd(sessionId: string, cwd: string): void {
    const meta = this.meta(sessionId)
    meta.cwd = cwd
    this.writeMeta(meta)
  }

  private deepestLeaf(startId: string, entries: SessionEntry[]): string {
    const kidsOf = new Map<string | null, SessionEntry[]>()
    for (const e of entries) {
      const list = kidsOf.get(e.parentId) ?? []
      list.push(e)
      kidsOf.set(e.parentId, list)
    }
    let current = startId
    for (let guard = 0; guard < 5000; guard++) {
      const kids = kidsOf.get(current)
      if (!kids?.length) return current
      kids.sort((a, b) => a.ts - b.ts)
      current = kids[kids.length - 1].id
    }
    return current
  }

  private pathEntries(leafId: string | null, byId: Map<string, SessionEntry>): SessionEntry[] {
    const out: SessionEntry[] = []
    let cursor = leafId
    const seen = new Set<string>()
    while (cursor) {
      if (seen.has(cursor)) break
      seen.add(cursor)
      const entry = byId.get(cursor)
      if (!entry) break
      out.push(entry)
      cursor = entry.parentId
    }
    return out.reverse()
  }

  private pathMessages(meta: SessionMeta, entries: SessionEntry[]): Message[] {
    const byId = new Map(entries.map((e) => [e.id, e]))
    return this.pathEntries(meta.leafId, byId).map((e) => e.message)
  }

  private writeMeta(meta: SessionMeta): void {
    const file = this.metaFile(meta.id)
    // meta 指针（leafId）一旦落后于 JSONL，回放就会丢消息；短暂重试吸收磁盘抖动
    let lastErr: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tmp = `${file}.tmp`
        writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
        renameSync(tmp, file)
        this.metaCache.set(meta.id, { stat: this.statOf(file), meta })
        return
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}
