import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import type { PluginInfo } from '@shared/types'
import type { AgentTool } from './agent/tools/types'
import { resolveInside } from './agent/tools/util'
import { downloadRepoZip, parseGitHubUrl } from './github'
import { unzip, type ZipEntry } from './zip'
import { paths } from './paths'
import { logger } from './logger'

const requireFn = createRequire(__filename)

const TOOL_NAME = /^[a-z][a-z0-9_]{1,40}$/
const ID_SAFE = /[^a-zA-Z0-9._-]/g

interface RegistryEntry {
  enabled: boolean
  installedAt: number
}

interface Registry {
  version: 1
  plugins: Record<string, RegistryEntry>
}

interface Manifest {
  name?: string
  version?: string
  description?: string
  main?: string
}

/** 传给插件工具 run() 的上下文 */
interface PluginToolCtx {
  workspace: string
  signal: AbortSignal
  log: (event: string, data?: unknown) => void
  resolve: (p: string) => string
}

/** 插件 beforeTool 钩子的裁决：allow（默认）/ deny（拦截并说明）/ modify（改写参数） */
export type BeforeToolVerdict =
  | { action: 'allow' }
  | { action: 'deny'; reason: string }
  | { action: 'modify'; input: Record<string, unknown> }

/** 插件在 index.js 里导出的形状 */
interface PluginModule {
  instructions?: string
  hooks?: {
    /**
     * 每次内置/插件工具执行前调用（子智能体同样经过）。
     * 返回 void/undefined 视为 allow；钩子抛异常按 allow 处理并记日志（fail-open，
     * 审计类插件自身故障不能把整个代理卡死）。
     */
    beforeTool?: (payload: { tool: string; input: Record<string, unknown> }) => BeforeToolVerdict | void
  }
  tools?: {
    name: string
    description: string
    parameters: Record<string, unknown>
    run: (
      input: Record<string, unknown>,
      ctx: PluginToolCtx
    ) => Promise<{ content: string; isError?: boolean }> | { content: string; isError?: boolean }
  }[]
}

function readRegistry(): Registry {
  try {
    const raw = JSON.parse(readFileSync(paths.pluginRegistry(), 'utf8')) as Registry
    if (raw && typeof raw === 'object' && raw.plugins) return { version: 1, plugins: raw.plugins }
  } catch {
    /* 没有或损坏都按空处理 */
  }
  return { version: 1, plugins: {} }
}

function writeRegistry(reg: Registry): void {
  const file = paths.pluginRegistry()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8')
  renameSync(tmp, file)
}

function readManifest(dir: string): Manifest {
  for (const name of ['plugin.json', 'package.json']) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Manifest
      if (raw && typeof raw === 'object') return raw
    } catch {
      /* 继续找下一个 */
    }
  }
  return {}
}

function safeId(raw: string): string {
  const id = raw.trim().replace(ID_SAFE, '-').replace(/^[.-]+/, '').slice(0, 48)
  return id || `plugin-${Date.now().toString(36)}`
}

/**
 * 把 zip 内容落到临时目录。
 * GitHub 归档顶层统一是 `<repo>-<ref>/`，先剥掉；再用 subpath 取子目录（支持 monorepo）。
 */
function writeEntries(root: string, entries: ZipEntry[], subpath?: string): void {
  const tops = new Set(entries.map((e) => e.name.split('/')[0]))
  const strip = tops.size === 1 ? `${[...tops][0]}/` : ''
  const base = resolve(root)
  const prefix = subpath ? `${subpath.replace(/^\/+|\/+$/g, '')}/` : ''
  let written = 0

  for (const entry of entries) {
    let rel = strip && entry.name.startsWith(strip) ? entry.name.slice(strip.length) : entry.name
    if (prefix) {
      if (!rel.startsWith(prefix)) continue
      rel = rel.slice(prefix.length)
    }
    if (!rel) continue

    const dest = resolve(base, rel)
    // zip slip：不允许写到临时目录之外
    if (dest !== base && !dest.startsWith(base + sep)) continue

    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, entry.data)
    if (++written > 2000) throw new Error('仓库文件数过多（>2000）')
  }

  if (!written) throw new Error(subpath ? `仓库里没有 ${subpath} 目录` : '压缩包是空的')
}

/** 插件根目录：优先压缩包根，其次一级子目录 */
function findManifestDir(root: string): string | null {
  const has = (dir: string): boolean =>
    ['plugin.json', 'package.json'].some((m) => existsSync(join(dir, m)))
  if (has(root)) return root
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      if (statSync(dir).isDirectory() && has(dir)) return dir
    } catch {
      /* 跳过 */
    }
  }
  return null
}

class PluginHost {
  private cache: PluginInfo[] = []
  private toolCache: AgentTool[] = []
  private instructionText = ''
  private loaded = false
  /** 已启用插件的 beforeTool 钩子（fail-open：钩子异常按 allow 处理） */
  private hookCache: { pluginId: string; beforeTool: NonNullable<PluginModule['hooks']>['beforeTool'] }[] = []

  private pluginRoot(): string {
    const root = paths.plugins()
    mkdirSync(root, { recursive: true })
    return root
  }

  private loadOne(
    id: string,
    dir: string,
    enabled: boolean
  ): {
    info: PluginInfo
    tools: AgentTool[]
    instructions: string
    hooks: { pluginId: string; beforeTool: NonNullable<PluginModule['hooks']>['beforeTool'] }[]
  } {
    const manifest = readManifest(dir)
    const info: PluginInfo = {
      id,
      name: typeof manifest.name === 'string' && manifest.name ? manifest.name : id,
      version: typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      enabled,
      tools: [],
      dir
    }

    if (!enabled) return { info, tools: [], instructions: '', hooks: [] }

    const main = typeof manifest.main === 'string' && manifest.main ? manifest.main : 'index.js'
    const entry = resolve(dir, main)
    // 入口必须在插件自己的目录里，防止清单指向任意文件
    if (!entry.startsWith(resolve(dir) + sep) && entry !== resolve(dir)) {
      info.error = `入口文件越界：${main}`
      return { info, tools: [], instructions: '', hooks: [] }
    }
    if (!existsSync(entry)) {
      info.error = `找不到入口文件：${main}`
      return { info, tools: [], instructions: '', hooks: [] }
    }

    try {
      delete requireFn.cache[entry]
      const mod = requireFn(entry) as PluginModule | { default?: PluginModule }
      const def: PluginModule = (mod as { default?: PluginModule }).default ?? (mod as PluginModule)

      const tools: AgentTool[] = []
      for (const t of Array.isArray(def?.tools) ? def.tools : []) {
        if (!t || typeof t.name !== 'string' || !TOOL_NAME.test(t.name)) {
          info.error = `工具名不合法：${String(t?.name)}`
          continue
        }
        if (typeof t.run !== 'function') {
          info.error = `工具 ${t.name} 缺少 run()`
          continue
        }
        tools.push({
          spec: {
            name: t.name,
            description: String(t.description ?? ''),
            parameters: (t.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} }
          },
          async run(input, ctx) {
            const out = await t.run(input, {
              workspace: ctx.workspace,
              signal: ctx.signal,
              log: ctx.log,
              // 给插件一个带路径守卫的解析器，避免它自己拼路径写飞
              resolve: (p: string) => resolveInside(ctx.workspace, p)
            })
            if (!out || typeof out.content !== 'string') {
              return { content: `Error: 插件工具 ${t.name} 没有返回 { content }`, isError: true }
            }
            return { content: out.content, isError: Boolean(out.isError) }
          }
        })
        info.tools.push(t.name)
      }

      const instructions = typeof def?.instructions === 'string' ? def.instructions : ''
      const hook = def?.hooks?.beforeTool
      const hooks: { pluginId: string; beforeTool: NonNullable<PluginModule['hooks']>['beforeTool'] }[] = []
      if (typeof hook === 'function') hooks.push({ pluginId: id, beforeTool: hook })
      return { info, tools, instructions, hooks }
    } catch (err) {
      info.error = `加载失败：${(err as Error).message}`
      logger.error('plugin.load_failed', { id, message: (err as Error).message })
      return { info, tools: [], instructions: '', hooks: [] }
    }
  }

  /**
   * 工具执行前的钩子链：任一插件 deny 即拦截，modify 逐层改写参数（后一个插件看到的是改后的）。
   * 钩子抛异常按 allow 处理并记日志（fail-open）。
   */
  runBeforeTool(tool: string, input: Record<string, unknown>): { input: Record<string, unknown>; denied?: string } {
    let current = input
    for (const { pluginId, beforeTool } of this.hookCache) {
      if (!beforeTool) continue
      try {
        const verdict = beforeTool({ tool, input: current })
        if (!verdict) continue
        if (verdict.action === 'deny') {
          logger.info('plugin.hook_deny', { pluginId, tool, reason: verdict.reason })
          return { input: current, denied: verdict.reason }
        }
        if (verdict.action === 'modify' && verdict.input && typeof verdict.input === 'object') {
          current = verdict.input
        }
      } catch (err) {
        logger.warn('plugin.hook_failed', { pluginId, tool, message: (err as Error).message })
      }
    }
    return { input: current }
  }

  reload(): PluginInfo[] {
    const root = this.pluginRoot()
    const reg = readRegistry()
    const infos: PluginInfo[] = []
    const tools: AgentTool[] = []
    const instructions: string[] = []
    const hooks: { pluginId: string; beforeTool: NonNullable<PluginModule['hooks']>['beforeTool'] }[] = []

    let dirs: string[] = []
    try {
      dirs = readdirSync(root).filter((name) => {
        try {
          return statSync(join(root, name)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      dirs = []
    }

    for (const id of dirs) {
      const entry = reg.plugins[id]
      const enabled = entry ? entry.enabled : true
      const loaded = this.loadOne(id, join(root, id), enabled)
      infos.push(loaded.info)
      tools.push(...loaded.tools)
      hooks.push(...loaded.hooks)
      if (loaded.instructions.trim()) instructions.push(loaded.instructions.trim())
      if (loaded.info.error) logger.warn('plugin.degraded', { id, error: loaded.info.error })
    }

    this.cache = infos.sort((a, b) => a.name.localeCompare(b.name))
    this.toolCache = tools
    this.instructionText = instructions.join('\n\n')
    this.hookCache = hooks
    this.loaded = true
    logger.info('plugin.loaded', { count: infos.length, tools: tools.length, hooks: hooks.length })
    return this.cache
  }

  list(): PluginInfo[] {
    if (!this.loaded) this.reload()
    return this.cache
  }

  tools(): AgentTool[] {
    if (!this.loaded) this.reload()
    return this.toolCache
  }

  instructions(): string {
    if (!this.loaded) this.reload()
    return this.instructionText
  }

  /** 从任意路径安装：目录、plugin.json/package.json，或单个 .js 文件 */
  install(sourcePath: string): PluginInfo {
    const root = this.pluginRoot()
    const src = resolve(sourcePath)
    if (!existsSync(src)) throw new Error('路径不存在')

    // 已经在插件目录里：不复制，直接启用它
    if (src.startsWith(root + sep)) {
      const id = basename(src)
      const reg = readRegistry()
      reg.plugins[id] = { enabled: true, installedAt: reg.plugins[id]?.installedAt ?? Date.now() }
      writeRegistry(reg)
      this.reload()
      return this.cache.find((p) => p.id === id) ?? { id, name: id, version: '0.0.0', description: '', enabled: true, tools: [], dir: src }
    }

    const stat = statSync(src)
    const isManifest = !stat.isDirectory() && /^(plugin|package)\.json$/i.test(basename(src))
    const isScript = !stat.isDirectory() && !isManifest
    const sourceDir = stat.isDirectory() ? src : dirname(src)

    const manifest = isScript ? {} : readManifest(sourceDir)
    const id = this.uniqueId(safeId(manifest.name || basename(sourceDir) || basename(src, extname(src))))
    const dest = join(root, id)

    mkdirSync(dest, { recursive: true })
    if (isScript) {
      const fileName = basename(src)
      cpSync(src, join(dest, fileName))
      const generated: Manifest = {
        name: manifest.name || basename(src, extname(src)),
        version: '0.0.0',
        description: '由单个脚本安装的本地插件',
        main: fileName
      }
      writeFileSync(join(dest, 'plugin.json'), JSON.stringify(generated, null, 2), 'utf8')
    } else {
      cpSync(sourceDir, dest, { recursive: true })
    }

    const reg = readRegistry()
    reg.plugins[id] = { enabled: true, installedAt: Date.now() }
    writeRegistry(reg)
    logger.info('plugin.installed', { id, from: src })
    this.reload()

    return this.cache.find((p) => p.id === id) ?? {
      id,
      name: id,
      version: '0.0.0',
      description: '',
      enabled: true,
      tools: [],
      dir: dest
    }
  }

  /** 从 GitHub 仓库在线安装：下载 zip → 解到临时目录 → 找到插件根 → 走本地安装流程 */
  async installFromGitHub(rawUrl: string): Promise<PluginInfo> {
    const target = parseGitHubUrl(rawUrl)
    const zipBuffer = await downloadRepoZip(target)

    const tmp = mkdtempSync(join(tmpdir(), 'pidesktop-gh-'))
    try {
      writeEntries(tmp, await unzip(zipBuffer), target.subpath)

      const pluginDir = findManifestDir(tmp)
      if (!pluginDir) throw new Error('仓库里没找到 plugin.json（根目录或一级子目录）')

      logger.info('plugin.github_install', {
        repo: `${target.owner}/${target.repo}`,
        ref: target.ref ?? 'HEAD',
        subpath: target.subpath ?? ''
      })
      return this.install(pluginDir)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  private uniqueId(base: string): string {    const root = this.pluginRoot()
    let id = base
    let n = 2
    while (existsSync(join(root, id))) id = `${base}-${n++}`
    return id
  }

  setEnabled(id: string, enabled: boolean): void {
    const reg = readRegistry()
    reg.plugins[id] = { enabled, installedAt: reg.plugins[id]?.installedAt ?? Date.now() }
    writeRegistry(reg)
    logger.info('plugin.toggled', { id, enabled })
    this.reload()
  }

  remove(id: string): void {
    const root = resolve(this.pluginRoot())
    const target = resolve(join(root, id))
    if (!target.startsWith(root + sep)) throw new Error('非法的插件 id')

    rmSync(target, { recursive: true, force: true })
    const reg = readRegistry()
    delete reg.plugins[id]
    writeRegistry(reg)
    logger.info('plugin.removed', { id })
    this.reload()
  }
}

export const pluginHost = new PluginHost()
