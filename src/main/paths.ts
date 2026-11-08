import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 数据根目录。桌面运行时默认 ~/.metis（配置、会话、日志、插件、自动项目目录都在这里）；
 * 纯 Node 环境（冒烟测试）可用 METIS_HOME 或旧名 PI_DESKTOP_HOME 指到临时目录。
 */
let dataDir: string | null = null

export function initPaths(dir?: string): string {
  const fromEnv = process.env.METIS_HOME || process.env.PI_DESKTOP_HOME
  dataDir = resolve(dir || fromEnv || join(homedir(), '.metis'))
  mkdirSync(dataDir, { recursive: true })
  return dataDir
}

export function getDataDir(): string {
  if (!dataDir) initPaths()
  return dataDir as string
}

export const paths = {
  config: () => join(getDataDir(), 'config.json'),
  sessions: () => join(getDataDir(), 'sessions'),
  logs: () => join(getDataDir(), 'logs'),
  /** 没选目录的会话在这里自动开一个 guid 目录 */
  projects: () => join(getDataDir(), 'projects'),
  /** 会话附件暂存根目录，一个会话一个子目录 */
  attachments: () => join(getDataDir(), 'attachments'),
  /** 一个插件一个目录 */
  plugins: () => join(getDataDir(), 'plugins'),
  pluginRegistry: () => join(getDataDir(), 'plugins.json'),
  /** 会话的子任务过程记录（每个 task 追加一行） */
  subagents: (sessionId: string) => join(paths.sessions(), `${sessionId}.subagents.jsonl`),
  /** 跨会话的全局记忆（模型通过 memory 工具维护） */
  memory: () => join(getDataDir(), 'MEMORY.md'),
  /** 用户画像（memory 工具 scope=user 维护），全量注入每次请求 */
  userProfile: () => join(getDataDir(), 'USER.md'),
  /** 用户自定义人格/口吻（存在即注入 system prompt） */
  soul: () => join(getDataDir(), 'SOUL.md'),
  /** 技能目录（模型通过 skills 工具自建自改，agentskills.io 风格的 SKILL.md） */
  skills: () => join(getDataDir(), 'skills'),
  /** 记忆图谱与全息元数据所在目录（与 MEMORY.md 同级） */
  memoryDir: () => getDataDir()
}

/**
 * 历史数据目录迁移：
 * 1) Electron userData（Windows 上是 %APPDATA%/pi-desktop）——最早期版本；
 * 2) ~/.pidesktop——"Pi Desktop" 时期的数据目录。
 * 更名 Metis 后默认数据目录为 ~/.metis，首次启动把旧目录的配置、会话、日志、
 * 记忆、技能、定时任务等搬过来，不动 Chromium 的缓存目录。目标已有配置时不覆盖。
 */
export function migrateLegacyData(legacyRoot: string): number {
  const target = getDataDir()
  if (!legacyRoot || resolve(legacyRoot) === target) return 0
  if (!existsSync(legacyRoot)) return 0
  if (existsSync(paths.config())) return 0 // 新目录已有配置，不覆盖

  const items = [
    'config.json',
    'sessions',
    'logs',
    'attachments',
    'projects',
    'plugins',
    'plugins.json',
    'MEMORY.md',
    'USER.md',
    'SOUL.md',
    'skills',
    'memory-graph.json',
    'memory-holo.json',
    'schedules.json'
  ]
  let moved = 0
  for (const item of items) {
    const src = join(legacyRoot, item)
    if (!existsSync(src)) continue
    try {
      cpSync(src, join(target, item), { recursive: true })
      moved++
    } catch {
      /* 单个文件搬失败不影响启动 */
    }
  }
  return moved
}
