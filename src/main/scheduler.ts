import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { paths } from './paths'
import { logger } from './logger'
import { assertSessionId } from './agent/session'
import type { AgentRunner } from './agent/runner'

/**
 * 定时任务：cron 表达式（本地时区 5 段）到点把一条 prompt 注入指定会话
 * （走 runner.send，运行中就是 steering 排队，空闲则开跑）。
 * 存 ~/.pidesktop/schedules.json；30s 粒度轮询 + 按"分钟"去重。
 */

export interface ScheduleTask {
  id: string
  name: string
  /** 5 段 cron：分 时 日 月 周（本地时区；0-7，0 与 7 都是周日） */
  cron: string
  prompt: string
  /** 到点注入的会话 */
  sessionId: string
  enabled: boolean
  createdAt: number
  /** 上次触发的 epoch 分钟数（防同一分钟重复触发） */
  lastFireMin?: number
}

interface ScheduleStore {
  version: 1
  tasks: ScheduleTask[]
}

const FILE = 'schedules.json'
const MAX_TASKS = 50

function file(): string {
  return `${paths.memoryDir()}/${FILE}`
}

function load(): ScheduleStore {
  if (!existsSync(file())) return { version: 1, tasks: [] }
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as ScheduleStore
    if (!Array.isArray(raw.tasks)) return { version: 1, tasks: [] }
    return { version: 1, tasks: raw.tasks.slice(0, MAX_TASKS) }
  } catch {
    return { version: 1, tasks: [] }
  }
}

function save(store: ScheduleStore): void {
  const tmp = `${file()}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, file())
}

/* ---------------- cron 解析与匹配 ---------------- */

const RANGE = /^(\d+)(?:-(\d+))?$/

function parseField(raw: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    const seg = part.trim()
    if (!seg) return null
    const [rangeRaw, stepRaw] = seg.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) return null
    let lo = min
    let hi = max
    if (rangeRaw !== '*') {
      const m = rangeRaw.match(RANGE)
      if (!m) return null
      lo = Number(m[1])
      hi = m[2] === undefined ? lo : Number(m[2])
      if (lo < min || lo > max || hi < min || hi > max || hi < lo) return null
    }
    for (let v = lo; v <= hi; v += step) {
      // dow 的 7 = 周日，统一折到 0
      out.add(max === 7 && v === 7 ? 0 : v)
    }
  }
  return out.size ? out : null
}

/** 解析 5 段 cron；非法返回 null（不抛，让上层给用户可读报错） */
export function parseCron(
  expr: string
): { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number> } | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const minute = parseField(parts[0], 0, 59)
  const hour = parseField(parts[1], 0, 23)
  const dom = parseField(parts[2], 1, 31)
  const month = parseField(parts[3], 1, 12)
  const dow = parseField(parts[4], 0, 7)
  if (!minute || !hour || !dom || !month || !dow) return null
  return { minute, hour, dom, month, dow }
}

export function cronMatches(expr: string, d: Date): boolean {
  const c = parseCron(expr)
  if (!c) return false
  // dom 与 dow 都受限时按 OR（经典 cron 语义）；任一是 * 时按 AND
  const fields = expr.trim().split(/\s+/)
  const domRestricted = fields[2] !== '*'
  const dowRestricted = fields[4] !== '*'
  if (!c.minute.has(d.getMinutes()) || !c.hour.has(d.getHours()) || !c.month.has(d.getMonth() + 1)) {
    return false
  }
  const domOk = c.dom.has(d.getDate())
  const dowOk = c.dow.has(d.getDay())
  if (domRestricted && dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

/* ---------------- 调度器 ---------------- */

let runnerRef: AgentRunner | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function bindScheduler(runner: AgentRunner): void {
  runnerRef = runner
}

function fire(task: ScheduleTask): void {
  if (!runnerRef) return
  try {
    assertSessionId(task.sessionId)
    const res = runnerRef.send(task.sessionId, task.prompt)
    logger.info('schedule.fired', { id: task.id, sessionId: task.sessionId, queued: res.queued })
  } catch (err) {
    // 会话可能已被删除：禁用任务而不是每次都报错
    logger.warn('schedule.fire_failed', { id: task.id, message: (err as Error).message })
    const store = load()
    const t = store.tasks.find((x) => x.id === task.id)
    if (t) {
      t.enabled = false
      save(store)
    }
  }
}

function tick(): void {
  const store = load()
  const now = new Date()
  const minuteKey = Math.floor(now.getTime() / 60_000)
  let dirty = false
  for (const task of store.tasks) {
    if (!task.enabled) continue
    if (task.lastFireMin === minuteKey) continue
    if (cronMatches(task.cron, now)) {
      task.lastFireMin = minuteKey
      dirty = true
      fire(task)
    }
  }
  if (dirty) save(store)
}

export function startScheduler(): void {
  if (timer) return
  timer = setInterval(tick, 30_000)
  timer.unref?.()
  tick()
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/* ---------------- 任务 CRUD（IPC 用） ---------------- */

export function listSchedules(): ScheduleTask[] {
  return load().tasks.sort((a, b) => a.createdAt - b.createdAt)
}

export function createSchedule(input: { name: string; cron: string; prompt: string; sessionId: string }): ScheduleTask {
  const name = input.name.trim().slice(0, 60)
  const prompt = input.prompt.trim()
  if (!name) throw new Error('任务名不能为空')
  if (!prompt) throw new Error('提示词不能为空')
  if (!parseCron(input.cron)) throw new Error(`cron 表达式不合法：${input.cron}（5 段：分 时 日 月 周）`)
  assertSessionId(input.sessionId)
  const store = load()
  if (store.tasks.length >= MAX_TASKS) throw new Error(`定时任务最多 ${MAX_TASKS} 个`)
  const task: ScheduleTask = {
    id: `sc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    cron: input.cron.trim(),
    prompt: prompt.slice(0, 2000),
    sessionId: input.sessionId,
    enabled: true,
    createdAt: Date.now()
  }
  store.tasks.push(task)
  save(store)
  logger.info('schedule.created', { id: task.id, cron: task.cron })
  return task
}

export function updateSchedule(
  id: string,
  patch: Partial<Pick<ScheduleTask, 'name' | 'cron' | 'prompt' | 'sessionId' | 'enabled'>>
): ScheduleTask {
  const store = load()
  const task = store.tasks.find((t) => t.id === id)
  if (!task) throw new Error(`没有这个定时任务：${id}`)
  if (typeof patch.name === 'string' && patch.name.trim()) task.name = patch.name.trim().slice(0, 60)
  if (typeof patch.cron === 'string') {
    if (!parseCron(patch.cron)) throw new Error(`cron 表达式不合法：${patch.cron}`)
    task.cron = patch.cron.trim()
  }
  if (typeof patch.prompt === 'string' && patch.prompt.trim()) task.prompt = patch.prompt.trim().slice(0, 2000)
  if (typeof patch.sessionId === 'string' && patch.sessionId) {
    assertSessionId(patch.sessionId)
    task.sessionId = patch.sessionId
  }
  if (typeof patch.enabled === 'boolean') task.enabled = patch.enabled
  save(store)
  return task
}

export function removeSchedule(id: string): void {
  const store = load()
  store.tasks = store.tasks.filter((t) => t.id !== id)
  save(store)
}
