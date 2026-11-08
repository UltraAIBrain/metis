import { shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ChangeList, DirEntry } from '@shared/types'

const MAX_DIFF_CHARS = 200_000

/** 路径守卫：只允许操作位于工作目录内的相对路径文件 */
function guardInside(cwd: string, raw: string): string {
  const p = String(raw ?? '').trim()
  if (!p || isAbsolute(p)) throw new Error('无效的文件路径')
  const full = resolve(cwd, p)
  const rel = relative(resolve(cwd), full)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('文件不在工作目录内')
  }
  return full
}

function guardExistingInside(cwd: string, raw: string): string {
  const full = guardInside(cwd, raw)
  if (!existsSync(full)) throw new Error(`文件不存在：${raw}`)
  const real = realpathSync(full)
  const rel = relative(realpathSync(cwd), real)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('文件真实路径不在工作目录内')
  }
  return real
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
      if (err) rejectP(err)
      else resolveP(stdout)
    })
  })
}

/** 在系统文件管理器中打开工作目录 */
export async function openWorkspace(cwd: string): Promise<void> {
  if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`)
  const err = await shell.openPath(cwd)
  if (err) throw new Error(err)
}

/** git 变更列表；不是 Git 仓库时返回 supported: false 而不是报错 */
export async function changes(cwd: string): Promise<ChangeList> {
  if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`)
  try {
    const out = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const tokens = out.split('\0')
    const files: ChangeList['files'] = []
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i]
      if (!entry) continue
      const rawStatus = entry.slice(0, 2)
      const status = rawStatus.trim() || rawStatus
      files.push({ status, path: entry.slice(3) })
      if (/[RC]/.test(rawStatus)) i++
    }
    return { supported: true, files }
  } catch {
    return { supported: false, files: [] }
  }
}

/** 单个文件的 diff（对 HEAD，含已暂存改动）；未跟踪文件没有 diff */
export async function diffOf(cwd: string, file: string): Promise<string> {
  const full = guardInside(cwd, file)
  if (existsSync(full)) guardExistingInside(cwd, file)
  const out = await git(cwd, ['diff', 'HEAD', '--', file]).catch(() => '')
  return out.length > MAX_DIFF_CHARS ? `${out.slice(0, MAX_DIFF_CHARS)}\n…（差异过长已截断）` : out
}

/** 用系统默认程序打开工作目录里的某个产物文件 */
export async function openFile(cwd: string, file: string): Promise<void> {
  const full = guardExistingInside(cwd, file)
  const err = await shell.openPath(full)
  if (err) throw new Error(err)
}

const MAX_DIR_ENTRIES = 500

/**
 * 目录树的单层列表（面板懒加载）：rel 为空表示工作目录根。
 * 符号链接不列出（防环、防越界）；目录在前、名称不区分大小写排序，单层封顶 500 条。
 */
export function listDir(cwd: string, rel: string): DirEntry[] {
  const full = rel.trim() === '' ? resolve(cwd) : guardExistingInside(cwd, rel)
  const real = realpathSync(full)
  const realRoot = realpathSync(cwd)
  const rootRel = relative(realRoot, real)
  if (rootRel === '..' || rootRel.startsWith(`..${sep}`) || isAbsolute(rootRel)) {
    throw new Error('目录不在工作目录内')
  }
  if (!statSync(real).isDirectory()) throw new Error(`「${rel}」不是目录`)

  const out: DirEntry[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(real, { withFileTypes: true })
  } catch (err) {
    throw new Error(`读取目录失败：${(err as Error).message}`)
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      out.push({ name: e.name, kind: 'dir', size: 0 })
    } else if (e.isFile()) {
      let size = 0
      try {
        size = statSync(join(real, e.name)).size
      } catch {
        /* 读不到大小就显示 0 */
      }
      out.push({ name: e.name, kind: 'file', size })
    }
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return out.slice(0, MAX_DIR_ENTRIES)
}

/* ------------------------------------------------------------------ */
/* 输入区 @ 引用：文件搜索与读取                                          */
/* ------------------------------------------------------------------ */

const AT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'release',
  'target', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage',
  '.next', '.turbo', '.cache'
])
const MAX_SCAN_FILES = 8000
const MAX_READ_BYTES = 256 * 1024

/**
 * 按文件名搜工作目录（@ 引用补全用）：递归 BFS，跳过依赖/产物目录与符号链接，
 * 名字包含匹配（不区分大小写）；最多扫 8000 个文件、返回 30 条，路径短的优先。
 */
export function searchFiles(cwd: string, query: string): string[] {
  const q = String(query ?? '').trim().toLowerCase()
  if (!q || !existsSync(cwd)) return []
  const hits: { rel: string }[] = []
  let scanned = 0
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: realpathSync(cwd), rel: '', depth: 0 }]
  while (queue.length && scanned < MAX_SCAN_FILES && hits.length < 200) {
    const item = queue.shift()!
    const { dir, rel, depth } = item
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (AT_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        if (depth < 8) queue.push({ dir: join(dir, e.name), rel: rel ? `${rel}/${e.name}` : e.name, depth: depth + 1 })
        continue
      }
      if (!e.isFile()) continue
      scanned++
      if (e.name.toLowerCase().includes(q)) hits.push({ rel: rel ? `${rel}/${e.name}` : e.name })
      if (scanned >= MAX_SCAN_FILES) break
    }
  }
  hits.sort((a, b) => a.rel.length - b.rel.length || a.rel.localeCompare(b.rel))
  return hits.slice(0, 30).map((h) => h.rel)
}

/** 读工作目录内的文本文件（@ 引用发送时内联用）；二进制/超限返回 null，让调用方跳过 */
export function readTextFile(cwd: string, rel: string): { name: string; text: string; bytes: number } | null {
  const full = guardExistingInside(cwd, rel)
  const st = statSync(full)
  if (st.size > MAX_READ_BYTES) return null
  const buf = readFileSync(full)
  if (buf.includes(0)) return null // 粗判二进制：含 NUL 字节就不当文本
  return { name: rel.split('/').pop() ?? rel, text: buf.toString('utf8'), bytes: buf.byteLength }
}
