import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import type { AgentTool, ToolContext, ToolResult } from './types'
import { asString, ToolError } from './util'

/**
 * RepoMind：工作目录的轻量知识图谱。
 *
 * 不引重型 parser：递归扫文件 + 正则提取 import/require 依赖与顶层符号定义，
 * 内存缓存（按 cwd），模型可以问"这个文件依赖谁 / 谁引用它 / 某符号定义在哪"。
 * 刻意限制规模：跳过依赖与构建产物目录、文件数封顶——这是给 agent 看的地图，不是 IDE。
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'out', 'target', 'vendor',
  '__pycache__', '.next', '.nuxt', 'coverage', '.venv', 'venv', '.idea', '.vscode'
])
const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.vue', '.svelte',
  '.css', '.scss', '.html', '.md', '.json', '.yml', '.yaml', '.toml', '.sql', '.sh'
])
const MAX_FILES = 3000
const MAX_FILE_BYTES = 512 * 1024
const MAX_SYMBOLS = 4000

interface FileNode {
  path: string
  ext: string
  lines: number
  bytes: number
}

interface SymbolNode {
  name: string
  path: string
  line: number
  kind: 'func' | 'class' | 'const'
}

interface RepoIndex {
  cwd: string
  builtAt: number
  files: FileNode[]
  /** 相对路径 → 它引用的相对路径集合 */
  deps: Map<string, Set<string>>
  symbols: SymbolNode[]
}

const indexCache = new Map<string, RepoIndex>()

function shouldSkip(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.') || name.endsWith('.d.ts')
}

const IMPORT_RE =
  /(?:import\s+[^'"]*?from\s+|import\s*\(\s*|require\s*\(\s*|from\s+import\s+)['"]([^'"]+)['"]/g

/** 相对 import 说明符 → 仓库内文件（尝试扩展名与 index 补全） */
function resolveSpecifier(spec: string, fromFile: string, cwd: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(fromFile, '..', spec)
  const rel = relative(cwd, base).replace(/\\/g, '/')
  const candidates = [
    rel,
    `${rel}.ts`, `${rel}.tsx`, `${rel}.js`, `${rel}.jsx`, `${rel}.mjs`,
    `${rel}.py`, `${rel}/index.ts`, `${rel}/index.tsx`, `${rel}/index.js`, `${rel}/__init__.py`
  ]
  for (const c of candidates) {
    if (fileSet.has(c)) return c
  }
  return null
}

const SYMBOL_RES: { kind: SymbolNode['kind']; re: RegExp }[] = [
  { kind: 'func', re: /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'class', re: /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'const', re: /(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\b|\()/g }
]

/** 索引有效期：agent 自己刚改过文件时，30 秒后自动重建，不必手动 rebuild */
const INDEX_TTL_MS = 30_000

function buildIndex(cwd: string): RepoIndex {
  const files: FileNode[] = []
  const fileSet = new Set<string>()

  const walk = (dir: string): void => {
    if (files.length >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return
      if (e.isDirectory()) {
        if (!shouldSkip(e.name)) walk(join(dir, e.name))
        continue
      }
      const ext = extname(e.name).toLowerCase()
      if (!TEXT_EXTS.has(ext)) continue
      const full = join(dir, e.name)
      const rel = relative(cwd, full).replace(/\\/g, '/')
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      files.push({ path: rel, ext, lines: 0, bytes: st.size })
      fileSet.add(rel)
    }
  }
  walk(cwd)

  const deps = new Map<string, Set<string>>()
  const symbols: SymbolNode[] = []

  for (const f of files) {
    let text: string
    try {
      text = readFileSync(join(cwd, f.path), 'utf8')
    } catch {
      continue
    }
    f.lines = text.split('\n').length

    // 依赖
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte'].includes(f.ext)) {
      const absFrom = join(cwd, f.path)
      for (const m of text.matchAll(IMPORT_RE)) {
        const target = resolveSpecifier(m[1], absFrom, cwd, fileSet)
        if (target && target !== f.path) {
          const set = deps.get(f.path) ?? new Set<string>()
          set.add(target)
          deps.set(f.path, set)
        }
      }
    } else if (f.ext === '.py') {
      for (const m of text.matchAll(/(?:^|\n)\s*from\s+([\w.]+)\s+import|(?:^|\n)\s*import\s+([\w.]+)/g)) {
        const mod = m[1] ?? m[2]
        if (!mod || !mod.includes('.')) continue
        const candidate = `${mod.replace(/\./g, '/')}.py`
        if (fileSet.has(candidate) && candidate !== f.path) {
          const set = deps.get(f.path) ?? new Set<string>()
          set.add(candidate)
          deps.set(f.path, set)
        }
      }
    }

    // 符号（每个文件每种取前若干个，防止单文件刷爆）
    if (symbols.length < MAX_SYMBOLS) {
      for (const { kind, re } of SYMBOL_RES) {
        let m: RegExpExecArray | null
        re.lastIndex = 0
        let count = 0
        while ((m = re.exec(text)) && count < 50 && symbols.length < MAX_SYMBOLS) {
          symbols.push({ name: m[1], path: f.path, line: text.slice(0, m.index).split('\n').length, kind })
          count++
        }
      }
    }
  }

  return { cwd, builtAt: Date.now(), files, deps, symbols }
}

function getIndex(cwd: string, force: boolean): RepoIndex {
  const key = resolve(cwd)
  const cached = indexCache.get(key)
  if (cached && !force && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached
  const idx = buildIndex(key)
  indexCache.set(key, idx)
  return idx
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

function extStats(files: FileNode[]): string {
  const byExt = new Map<string, { count: number; lines: number }>()
  for (const f of files) {
    const e = byExt.get(f.ext) ?? { count: 0, lines: 0 }
    e.count++
    e.lines += f.lines
    byExt.set(f.ext, e)
  }
  return [...byExt.entries()]
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, 10)
    .map(([ext, v]) => `${ext || '(none)'}: ${v.count} 文件 / ${v.lines} 行`)
    .join('\n')
}

/**
 * repomind：仓库知识图谱查询。
 * 索引在首次调用时构建并缓存（按工作目录），rebuild 显式重建。
 */
export const repomindTool: AgentTool = {
  spec: {
    name: 'repomind',
    description:
      'Query a lightweight knowledge graph of the working directory: file inventory, import/require dependency edges, and top-level symbol definitions (functions/classes). ' +
      'Cheaper and more structured than grepping around — use it to answer "what depends on X", "where is Y defined", or to get an overview before diving in. ' +
      'The index is built on first use and cached; rebuild after large refactorings.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['stats', 'deps', 'usedby', 'symbol', 'rebuild'],
          description:
            'stats = overview (file count, languages, largest files); deps = what a file imports (inside the repo); usedby = which files import it; symbol = where a symbol is defined; rebuild = force re-index.'
        },
        target: { type: 'string', description: 'File path (for deps/usedby) or symbol name (for symbol).' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = asString(input, 'action', { required: true })
    const target = asString(input, 'target', { fallback: '' }).trim()

    if (action === 'rebuild') {
      getIndex(ctx.workspace, true)
      const idx = getIndex(ctx.workspace, false)
      return { content: `已重建索引：${idx.files.length} 个文件，${idx.symbols.length} 个符号。`, isError: false }
    }

    const idx = getIndex(ctx.workspace, false)

    if (action === 'stats') {
      const top = [...idx.files].sort((a, b) => b.lines - a.lines).slice(0, 8)
      const edgeCount = [...idx.deps.values()].reduce((n, s) => n + s.size, 0)
      const body = [
        `文件 ${idx.files.length} 个 · 依赖边 ${edgeCount} 条 · 符号 ${idx.symbols.length} 个`,
        idx.files.length >= MAX_FILES ? `（已达 ${MAX_FILES} 文件上限，索引不完整，结果可能漏报）` : '',
        '',
        '语言分布：',
        extStats(idx.files),
        '',
        '最大的文件：',
        ...top.map((f) => `  ${f.path} — ${f.lines} 行 (${fmtBytes(f.bytes)})`),
        '',
        '依赖最多的文件：',
        ...[...idx.deps.entries()]
          .sort((a, b) => b[1].size - a[1].size)
          .slice(0, 5)
          .map(([p, s]) => `  ${p} → ${s.size} 个依赖`)
      ].join('\n')
      return { content: body, isError: false }
    }

    if (action === 'deps' || action === 'usedby') {
      if (!target) throw new ToolError(`action=${action} 需要 target（文件路径）`)
      const norm = target.replace(/\\/g, '/')
      const hit = idx.files.find((f) => f.path === norm || f.path.endsWith(`/${norm}`))
      if (!hit) throw new ToolError(`索引里没有这个文件：${norm}（只索引文本源码，可先 stats 看看）`)

      if (action === 'deps') {
        const list = [...(idx.deps.get(hit.path) ?? new Set<string>())].sort()
        return { content: list.length ? `${hit.path} 引用了 ${list.length} 个仓库内文件：\n${list.map((p) => `  ${p}`).join('\n')}` : `${hit.path} 没有引用仓库内其他文件。`, isError: false }
      }
      const usedBy: string[] = []
      for (const [from, set] of idx.deps) {
        if (set.has(hit.path)) usedBy.push(from)
      }
      usedBy.sort()
      return { content: usedBy.length ? `${usedBy.length} 个文件引用了 ${hit.path}：\n${usedBy.map((p) => `  ${p}`).join('\n')}` : `没有仓库内文件引用 ${hit.path}。`, isError: false }
    }

    if (action === 'symbol') {
      if (!target) throw new ToolError('action=symbol 需要 target（符号名）')
      const lower = target.toLowerCase()
      const exact = idx.symbols.filter((s) => s.name.toLowerCase() === lower)
      const partial = idx.symbols.filter((s) => {
        const n = s.name.toLowerCase()
        return n !== lower && n.includes(lower)
      })
      // 精确匹配全部保留，模糊匹配补足到上限——截断发生在排序之后
      const ordered = [...exact, ...partial].slice(0, 30)
      if (!ordered.length) return { content: `没有找到符号「${target}」。`, isError: false }
      const omitted = exact.length + partial.length - ordered.length
      return {
        content:
          `${ordered.length} 处定义（精确匹配在前）${omitted > 0 ? `，另有 ${omitted} 处未列出` : ''}：\n` +
          ordered.map((s) => `  [${s.kind}] ${s.name} — ${s.path}:${s.line}`).join('\n'),
        isError: false
      }
    }

    throw new ToolError(`未知的 action：${action}`)
  }
}

