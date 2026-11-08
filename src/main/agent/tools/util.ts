import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** 根目录的真实路径；根不存在（理论上 runner 已懒创建）时原样返回并降级为字符串校验 */
function realRoot(root: string): string {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

/**
 * 把模型给的路径锚定在工作目录内。
 * 桌面端有真实文件系统权限，越界写文件是不可接受的，这里直接拒绝。
 * 两层校验：先按字符串 relative 拦 `../` 与绝对路径；再对已存在的目标做
 * realpath 解析——工作目录内指向外部的符号链接同样不允许越界。
 */
export function resolveInside(root: string, p: string): string {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('path 不能为空')
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(resolve(root), abs)
  if (rel === '') return abs
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(`路径超出工作目录：${p}（当前工作目录 ${root}）`)
  }
  if (existsSync(abs)) {
    try {
      const real = realpathSync(abs)
      const realRel = relative(realRoot(root), real)
      if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
        throw new ToolError(`路径经符号链接指向工作目录之外：${p}`)
      }
      return real
    } catch (err) {
      if (err instanceof ToolError) throw err
      /* realpath 失败（竞态删除等）时按原路径继续，后续 fs 调用自然报错 */
    }
  }
  return abs
}

export function relPath(root: string, abs: string): string {
  const rel = relative(resolve(root), abs)
  return (norm(rel) || '.') === '.' ? '.' : rel.split(sep).join('/')
}

export function asString(input: Record<string, unknown>, key: string, opts: { required?: boolean; fallback?: string } = {}): string {
  const v = input[key]
  if (typeof v === 'string') {
    if (!v.length && opts.required) throw new ToolError(`${key} 不能为空字符串`)
    return v
  }
  if (v === undefined || v === null) {
    if (opts.fallback !== undefined) return opts.fallback
    throw new ToolError(`缺少参数 ${key}（应为字符串）`)
  }
  throw new ToolError(`参数 ${key} 应为字符串，收到 ${typeof v}`)
}

export function asOptionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key]
  if (v === undefined || v === null) return undefined
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new ToolError(`参数 ${key} 应为数字`)
  return n
}

export function asOptionalBool(input: Record<string, unknown>, key: string): boolean | undefined {
  const v = input[key]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'boolean') return v
  throw new ToolError(`参数 ${key} 应为布尔值`)
}

/** 统一把字节数变成人类可读。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
