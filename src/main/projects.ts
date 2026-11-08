import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { paths } from './paths'

/**
 * 懒创建项目目录：会话创建时可以先不指定目录，
 * 真正开始跑第一条消息时再在 <data>/projects/<guid> 下开一个。
 */
export function ensureProjectDir(): string {
  const root = paths.projects()
  mkdirSync(root, { recursive: true })
  const dir = join(root, randomUUID())
  mkdirSync(dir, { recursive: true })
  return dir
}
