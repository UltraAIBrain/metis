import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Attachment } from '@shared/types'
import { paths } from './paths'
import { assertSessionId } from './agent/session'

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_TEXT_BYTES = 256 * 1024
export const MAX_ATTACHMENTS = 8

/** 两个协议族都能直接消费的图片格式 */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.css', '.scss', '.html', '.htm', '.xml', '.svg', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.py', '.rs', '.go', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php',
  '.sh', '.bat', '.ps1', '.sql', '.csv', '.tsv', '.log', '.env', '.gitignore', '.dockerfile'
])

const TEXT_MIME_FRAGMENTS = ['text/', 'json', 'xml', 'javascript', 'yaml', 'csv']

export function sessionAttachmentsDir(sessionId: string): string {
  return join(paths.attachments(), assertSessionId(sessionId))
}

function safeName(name: string): string {
  const base = basename(String(name || 'file')).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80)
  return base || 'file'
}

function isTextual(mime: string, name: string): boolean {
  const lower = mime.toLowerCase()
  if (TEXT_MIME_FRAGMENTS.some((f) => lower.includes(f))) return true
  return TEXT_EXTS.has(extname(name).toLowerCase())
}

export function attachmentLimit(rawName: string, rawMime: string): number {
  const mime = rawMime.toLowerCase().trim()
  if (IMAGE_MIMES.has(mime)) return MAX_IMAGE_BYTES
  if (isTextual(mime, rawName)) return MAX_TEXT_BYTES
  throw new Error(`暂不支持「${safeName(rawName)}」的格式（${mime || '未知类型'}）；目前支持图片与文本文件`)
}

/** 选择框只有路径没有 mime；按扩展名给出保守猜测，最终类型判定仍以 stage 为准 */
export function pickMime(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.md' || ext === '.markdown') return 'text/markdown'
  if (ext === '.json' || ext === '.jsonl') return 'application/json'
  if (ext === '.csv' || ext === '.tsv') return 'text/csv'
  if (ext === '.html' || ext === '.htm') return 'text/html'
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'text/javascript'
  if (ext === '.ts' || ext === '.tsx' || ext === '.jsx') return 'text/typescript'
  if (ext === '.xml' || ext === '.svg') return 'text/xml'
  if (ext === '.yml' || ext === '.yaml') return 'text/yaml'
  return 'text/plain'
}

/**
 * 把渲染层传来的文件字节写入本会话的附件目录，返回可随消息落盘的元数据。
 * 只收图片与文本两类：图片作为 image 块发给模型，文本在请求时内联为带标记的正文。
 */
export function stageAttachment(sessionId: string, rawName: string, rawMime: string, bytes: Uint8Array): Attachment {
  assertSessionId(sessionId)
  const name = safeName(rawName)
  const mime = String(rawMime || '').toLowerCase().trim()
  const size = bytes.byteLength

  let kind: Attachment['kind']
  if (IMAGE_MIMES.has(mime)) {
    if (size > MAX_IMAGE_BYTES) throw new Error(`图片「${name}」超过 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`)
    kind = 'image'
  } else if (isTextual(mime, name)) {
    if (size > MAX_TEXT_BYTES) throw new Error(`文本附件「${name}」超过 256KB 上限，请把要点粘贴进消息正文`)
    kind = 'text'
  } else {
    throw new Error(`暂不支持「${name}」的格式（${mime || '未知类型'}）；目前支持图片与文本文件`)
  }
  if (size === 0) throw new Error(`「${name}」是空文件`)

  const dir = sessionAttachmentsDir(sessionId)
  mkdirSync(dir, { recursive: true })
  const id = `a_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
  const file = join(dir, `${id}-${name}`)
  writeFileSync(file, bytes)

  return { id, name, mime: mime || (kind === 'image' ? 'image/png' : 'text/plain'), size, kind, path: file }
}

/**
 * 渲染层传入的附件必须位于本会话的附件目录内——
 * 消息会进 JSONL，理论上存在被篡改后指到任意文件的可能，这里统一收口。
 */
export function validAttachmentsFor(sessionId: string, raw: unknown): Attachment[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`一条消息最多带 ${MAX_ATTACHMENTS} 个附件`)
  const root = resolve(sessionAttachmentsDir(sessionId)) + sep
  const out: Attachment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('无效的附件')
    const a = item as Partial<Attachment>
    if (typeof a.path !== 'string' || typeof a.name !== 'string') throw new Error('无效的附件')
    const path = resolve(a.path)
    if (!path.startsWith(root)) throw new Error(`附件「${a.name}」不在本会话的暂存目录内，已拒绝`)
    if (!existsSync(path)) throw new Error(`附件「${a.name}」已不存在，请重新添加`)
    const realRoot = realpathSync(sessionAttachmentsDir(sessionId)) + sep
    const realPath = realpathSync(path)
    if (!realPath.startsWith(realRoot)) throw new Error(`附件「${a.name}」越出了本会话目录，已拒绝`)
    const stat = statSync(realPath)
    if (!stat.isFile()) throw new Error(`附件「${a.name}」不是普通文件`)
    if (stat.size > attachmentLimit(a.name, String(a.mime ?? ''))) throw new Error(`附件「${a.name}」超过大小上限`)
    if (a.kind !== 'image' && a.kind !== 'text') throw new Error(`附件「${a.name}」类型无效`)
    out.push({
      id: String(a.id ?? ''),
      name: safeName(a.name),
      mime: String(a.mime ?? ''),
      size: stat.size,
      kind: a.kind,
      path: realPath
    })
  }
  return out
}

export function removeSessionAttachments(sessionId: string): void {
  const root = resolve(paths.attachments())
  const dir = resolve(sessionAttachmentsDir(sessionId))
  const rel = relative(root, dir)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('附件删除路径越界')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  for (const key of payloadCache.keys()) {
    if (key.startsWith(dir + sep)) uncache(key)
  }
}

/* ------------------------------------------------------------------ */
/* 请求构造时的内容读取（带缓存，避免长会话每一步重复 base64 大图片）      */
/* ------------------------------------------------------------------ */

interface PayloadCache {
  key: string
  base64: string
}
const payloadCache = new Map<string, PayloadCache>()
const PAYLOAD_CACHE_MAX_CHARS = 32 * 1024 * 1024
let payloadCacheChars = 0

function uncache(path: string): void {
  const hit = payloadCache.get(path)
  if (!hit) return
  payloadCache.delete(path)
  payloadCacheChars -= hit.base64.length
}

function cachedBase64(att: Attachment): string {
  const st = statSync(att.path)
  const key = `${st.size}:${st.mtimeMs}`
  const hit = payloadCache.get(att.path)
  if (hit && hit.key === key) return hit.base64
  uncache(att.path)
  const base64 = readFileSync(att.path).toString('base64')
  if (base64.length > PAYLOAD_CACHE_MAX_CHARS) return base64
  while (payloadCache.size && payloadCacheChars + base64.length > PAYLOAD_CACHE_MAX_CHARS) {
    const oldest = payloadCache.keys().next().value
    if (oldest) uncache(oldest)
  }
  payloadCache.set(att.path, { key, base64 })
  payloadCacheChars += base64.length
  return base64
}

/** 图片附件 → base64，供 OpenAI（data URL）与 Anthropic（source.base64）使用 */
export function attachmentBase64(att: Attachment): string {
  return cachedBase64(att)
}

/** 文本附件 → 请求里内联的正文；按 UTF-8 读，二进制内容替换为提示 */
export function attachmentText(att: Attachment): string {
  const buf = readFileSync(att.path)
  const text = buf.toString('utf8')
  if (text.includes('\uFFFD')) return '（无法按文本解码，内容已跳过）'
  return text
}
