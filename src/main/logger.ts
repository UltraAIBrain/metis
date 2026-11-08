import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { paths } from './paths'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MAX_FILES = 7

function dayKey(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 把任意值压成可读的单行摘要，避免日志被超长的工具输出撑爆。 */
function shape(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…(+${value.length - 2000})` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 4).join('\n') }
  if (depth > 2) return '[deep]'
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => shape(v, depth + 1))
    return value.length > 20 ? [...head, `…(+${value.length - 20})`] : head
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = shape(v, depth + 1)
    return out
  }
  return String(value)
}

/**
 * JSONL 日志：一天一个文件，保留 7 天。
 * 代理侧只关心 event + data，不关心落盘细节。
 */
export class Logger {
  private stream: WriteStream | null = null
  private currentDay = ''
  private min: number

  constructor(level: LogLevel = 'info') {
    this.min = LEVEL_ORDER[level]
  }

  setLevel(level: LogLevel): void {
    this.min = LEVEL_ORDER[level]
  }

  debug(event: string, data?: unknown): void {
    this.write('debug', event, data)
  }
  info(event: string, data?: unknown): void {
    this.write('info', event, data)
  }
  warn(event: string, data?: unknown): void {
    this.write('warn', event, data)
  }
  error(event: string, data?: unknown): void {
    this.write('error', event, data)
  }

  private ensureStream(): WriteStream {
    const day = dayKey()
    if (this.stream && this.currentDay === day) return this.stream
    this.close()
    const dir = paths.logs()
    mkdirSync(dir, { recursive: true })
    this.prune(dir)
    this.currentDay = day
    const stream = createWriteStream(join(dir, `app-${day}.jsonl`), { flags: 'a' })
    this.stream = stream
    stream.on('error', (err) => {
      if (this.stream === stream) this.stream = null
      console.error('[error] log.stream', err.message)
    })
    return stream
  }

  private prune(dir: string): void {
    try {
      const files = readdirSync(dir)
        .filter((f) => /^app-.*\.jsonl$/.test(f))
        .sort()
      while (files.length > MAX_FILES - 1) {
        const victim = files.shift()
        if (!victim) break
        const full = join(dir, victim)
        if (existsSync(full)) unlinkSync(full)
      }
    } catch {
      /* 轮转失败不影响主流程 */
    }
  }

  private write(level: LogLevel, event: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < this.min) return
    const record = { ts: new Date().toISOString(), level, event, data: shape(data) }
    try {
      this.ensureStream().write(`${JSON.stringify(record)}\n`)
    } catch {
      /* 落盘失败时退化为控制台 */
    }
    if (level === 'error' || level === 'warn') console.error(`[${level}] ${event}`, data ?? '')
  }

  close(): void {
    this.stream?.end()
    this.stream = null
  }
}

export const logger = new Logger(process.env.PI_LOG_LEVEL === 'debug' ? 'debug' : 'info')
