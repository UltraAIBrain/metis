import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { paths } from '../paths'

/**
 * 记忆领域模块：MEMORY.md / USER.md 的读写、条目解析、图谱与全息元数据、
 * 检索（分词打分 + 图扩展）与 system prompt 注入、以及"该记而未记"的 nudge 状态。
 * memory 工具与 prompt 注入共用这一份逻辑。
 */

/** 文件本身的上限：到这个大小必须精简，防止记忆无限膨胀（注入 = 每条消息都在烧 token） */
export const MAX_MEMORY_CHARS = 16_000
export const MAX_USER_CHARS = 4_000

export interface MemoryGraph {
  nextId: number
  edges: { a: string; b: string; relation: string; at: number }[]
}

export interface HoloMeta {
  session?: string
  cwd?: string
  at: number
}

const GRAPH_FILE = 'memory-graph.json'
const HOLO_FILE = 'memory-holo.json'
/** 图谱边数上限：防无限膨胀 */
export const GRAPH_MAX_EDGES = 500

export function readMemory(): string {
  const file = paths.memory()
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export function writeMemory(content: string): void {
  atomicWrite(paths.memory(), content)
}

export function readUser(): string {
  const file = paths.userProfile()
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export function writeUser(content: string): void {
  atomicWrite(paths.userProfile(), content)
}

/** 原子写：先写临时文件再重命名，避免半截文件 */
function atomicWrite(file: string, content: string): void {
  writeFileSync(file + '.tmp', content, 'utf8')
  renameSync(file + '.tmp', file)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown): void {
  atomicWrite(file, JSON.stringify(data, null, 2) + '\n')
}

export function loadGraph(): MemoryGraph {
  return readJson<MemoryGraph>(paths.memoryDir() + '/' + GRAPH_FILE, { nextId: 1, edges: [] })
}

export function saveGraph(graph: MemoryGraph): void {
  writeJson(paths.memoryDir() + '/' + GRAPH_FILE, graph)
}

export function loadHolo(): Record<string, HoloMeta> {
  return readJson<Record<string, HoloMeta>>(paths.memoryDir() + '/' + HOLO_FILE, {})
}

export function saveHolo(holo: Record<string, HoloMeta>): void {
  writeJson(paths.memoryDir() + '/' + HOLO_FILE, holo)
}

export interface Entry {
  id: string
  date: string
  text: string
}

const ENTRY_LINE = /^-\s+\((m\d+)\)\s+(?:\[(\d{4}-\d{2}-\d{2})\]\s+)?(.*)$/

/** 解析 `- (m3) [2026-11-07] 内容`；无 id 的旧行 id 为空但仍能显示 */
export function parseEntries(raw: string): Entry[] {
  const out: Entry[] = []
  for (const line of raw.split('\n')) {
    const m = line.match(ENTRY_LINE)
    if (m) out.push({ id: m[1], date: m[2] ?? '', text: m[3] })
  }
  return out
}

export function nextEntryId(graph: MemoryGraph): string {
  const id = 'm' + graph.nextId
  graph.nextId++
  return id
}

/* ---------------- 检索：分词 + 词频倒排 + 图扩展 ---------------- */

/**
 * 分词：拉丁词整词（≥2 字符）+ CJK 连续段切 2-gram（单字整段保留）。
 * 比"子串包含"公平：短查询词不会因为撞进别的长词而误命中。
 */
export function tokenize(s: string): string[] {
  const out: string[] = []
  for (const m of s.matchAll(/[a-z0-9_]{2,}/gi)) out.push(m[0].toLowerCase())
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = m[0]
    if (seg.length === 1) out.push(seg)
    else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2))
  }
  return out
}

/** 检索打分：查询 token 命中数 × 稀有度（出现该 token 的条目越少分越高）+ 图一跳邻居减半 */
export function scoreEntries(query: string, entries: Entry[], graph: MemoryGraph): { entry: Entry; score: number }[] {
  const queryTokens = [...new Set(tokenize(query))]
  if (!queryTokens.length) return []
  // 文档频率：token 在多少条记忆里出现
  const df = new Map<string, number>()
  const entryTokens = entries.map((e) => {
    const toks = new Set(tokenize(e.text + ' ' + e.date))
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1)
    return toks
  })
  const base = new Map<string, number>()
  entries.forEach((e, i) => {
    let s = 0
    for (const q of queryTokens) {
      if (!entryTokens[i].has(q)) continue
      // idf 近似：越稀有的 token 命中越值钱（log 压缩，避免极端值）
      s += 1 + 1 / Math.log2(2 + (df.get(q) ?? 1))
    }
    if (s > 0) base.set(e.id, s)
  })
  // 图扩展：直接命中的条目的邻居带一半分（关联记忆大概率也相关）
  for (const edge of graph.edges) {
    const aHit = base.get(edge.a)
    const bHit = base.get(edge.b)
    if (aHit && !base.has(edge.b)) base.set(edge.b, aHit / 2)
    if (bHit && !base.has(edge.a)) base.set(edge.a, bHit / 2)
  }
  return [...base.entries()]
    .map(([id, score]) => ({ entry: entries.find((e) => e.id === id)!, score }))
    .filter((x) => x.entry)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
}

/**
 * 构建注入进 system prompt 的记忆块（检索式）：
 * 与当前任务最相关的条目 + 最新的几条，去重后按 相关 → 最近 排序。
 * 文件不大时直接整份注入（便宜路径）。
 */
export function buildMemoryInjection(query: string, budget: number): string {
  const raw = readMemory().trim()
  if (!raw) return ''
  if (raw.length <= budget) return raw

  const entries = parseEntries(raw)
  const graph = loadGraph()
  const relevant = scoreEntries(query, entries, graph)
    .slice(0, 10)
    .map((h) => h.entry)
  const recent = entries.slice(-5)
  const seen = new Set<string>()
  const picked: Entry[] = []
  for (const e of [...relevant, ...recent]) {
    if (!e.id || seen.has(e.id)) continue
    seen.add(e.id)
    picked.push(e)
  }

  const line = (e: Entry): string => '- (' + e.id + ') [' + e.date + '] ' + e.text
  const out: string[] = [
    '(记忆已超过注入上限，按相关度 + 最近注入；完整记忆用 memory 工具 action=read 查看，action=rewrite 精简)',
    ...picked.map(line)
  ]
  let total = out.join('\n').length
  while (total > budget && out.length > 2) {
    total -= out[out.length - 1].length
    out.pop()
  }
  return out.join('\n')
}

/* ---------------- nudge：该记而未记的提醒 ---------------- */

let memoryWrittenSinceRunStart = false
let nudgePending = false

/** memory 工具写入时调用（append / rewrite / user 写入都算） */
export function noteMemoryWrite(): void {
  memoryWrittenSinceRunStart = true
  nudgePending = false
}

/** run 结束时调用：用过工具但全程没写记忆 → 下一轮提醒一次（只提醒一次，不唠叨） */
export function noteRunEnd(usedTools: boolean): void {
  if (usedTools && !memoryWrittenSinceRunStart) nudgePending = true
  memoryWrittenSinceRunStart = false
}

/** 下一轮 system prompt 是否附带 nudge；消费即清零 */
export function consumeNudge(): boolean {
  const v = nudgePending
  nudgePending = false
  return v
}
