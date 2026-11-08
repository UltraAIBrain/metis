import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/** 新文件也要解析父目录中的链接；悬空链接或权限错误不能按普通缺失路径放行。 */
function realPathWithMissingTail(abs: string): string {
  let ancestor = abs
  for (;;) {
    try {
      lstatSync(ancestor)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw err
      ancestor = dirname(ancestor)
    }
  }
  return resolve(realpathSync(ancestor), relative(ancestor, abs))
}

/**
 * 把模型给的路径锚定在工作目录内。
 * 桌面端有真实文件系统权限，越界写文件是不可接受的，这里直接拒绝。
 * 两层校验：先按字符串 relative 拦越界路径；再解析目标或最近存在的父目录，
 * 防止通过目录链接向工作目录之外新建文件。无法验证的链接拒绝访问。
 */
export function resolveInside(root: string, p: string): string {
  if (typeof p !== 'string' || !p.trim()) throw new ToolError('path 不能为空')
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  const rel = relative(resolve(root), abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(`路径超出工作目录：${p}（当前工作目录 ${root}）`)
  }
  try {
    const real = realPathWithMissingTail(abs)
    const realRel = relative(realPathWithMissingTail(resolve(root)), real)
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
      throw new ToolError(`路径经符号链接指向工作目录之外：${p}`)
    }
    return real
  } catch (err) {
    if (err instanceof ToolError) throw err
    throw new ToolError(`无法校验文件真实路径：${p}（${(err as Error).message}）`)
  }
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
