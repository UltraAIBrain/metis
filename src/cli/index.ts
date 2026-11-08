/**
 * Pi 终端版：纯 Node REPL，零 Electron 依赖。
 * 复用主进程的全部核心（runner / session / config / tools / plugins / 记忆 / 轨迹），
 * 只把界面换成终端流式渲染。
 *
 * 启动：pi [--new] [--session <id>] [--dir <工作目录>]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import readline from 'node:readline'
import { initPaths, paths } from '../main/paths'
import { Logger } from '../main/logger'
import { ConfigStore, fallbackSecretBox } from '../main/config'
import { SessionStore } from '../main/agent/session'
import { AgentRunner } from '../main/agent/runner'
import { pluginHost } from '../main/plugins'
import { attachmentLimit, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, pickMime, stageAttachment } from '../main/attachments'
import { startLogin } from '../main/oauth'
import { buildTrajectory } from '../main/trajectory'
import { trajectoryToMarkdown } from '../main/trajectory-md'
import type { AgentEvent, AssistantMessage, ToolMessage } from '../shared/types'

/* ---------------- 终端着色（检测 TTY，管道输出自动去色） ---------------- */

const isTTY = process.stdout.isTTY
const c = {
  dim: (s: string): string => (isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  cyan: (s: string): string => (isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string): string => (isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string): string => (isTTY ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string): string => (isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s: string): string => (isTTY ? `\x1b[1m${s}\x1b[0m` : s)
}
const write = (s: string): void => {
  process.stdout.write(s)
}

/* ---------------- 状态 ---------------- */

const logger = new Logger('info')
// store 在 main() 里 initPaths 之后构造（--home 才能生效）
let config!: ConfigStore
let sessions!: SessionStore
let runner: AgentRunner
let sessionId = ''
let pendingAttachments: import('../shared/types').Attachment[] | undefined
let thinkingShown = false
/** 正在运行的会话集合：run_start/run_end 无条件更新，与当前显示的会话解耦，切换后不会卡住 */
const runningIds = new Set<string>()
const toolStartedAt = new Map<string, number>()
let rlRef: readline.Interface | null = null
let sigintPending = false

/** 统一退出：先关日志，留一拍让 stdout/日志流 flush，避免 process.exit 丢缓冲 */
function exitSoon(code: number): void {
  logger.close()
  setTimeout(() => process.exit(code), 80).unref?.()
}

function isRunning(): boolean {
  return runningIds.size > 0
}

function short(s: string, n = 88): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

function metaLine(m: ToolMessage): string {
  const meta = m.meta
  if (!meta) return ''
  if (meta.kind === 'bash') return `exit ${meta.exitCode ?? '—'}${meta.timedOut ? ' · 超时' : ''}${meta.truncated ? ' · 截断' : ''}`
  if (meta.kind === 'task')
    return `子任务 ${meta.steps} 步 · in ${meta.inputTokens} / out ${meta.outputTokens}${
      meta.durationMs ? ` · ${(meta.durationMs / 1000).toFixed(1)}s` : ''
    }`
  return ''
}

/* ---------------- 事件渲染 ---------------- */

function renderEvent(e: AgentEvent): void {
  // 运行状态无条件跟踪（否则切换会话后旧 run 的 run_end 被过滤，running 会永远卡住）；
  // 其余输出按当前会话路由：切走后旧会话的事件不再往新会话的终端里打
  if (e.type === 'run_start') runningIds.add(e.sessionId)
  if (e.type === 'run_end') runningIds.delete(e.sessionId)
  if ('sessionId' in e && e.sessionId !== sessionId) {
    if (e.type === 'run_end' && runningIds.size === 0) rlRef?.prompt()
    return
  }
  switch (e.type) {
    case 'session_cwd':
      write(`  ${c.dim(`📁 工作目录：${e.cwd}`)}\n`)
      break
    case 'assistant_start':
      write('\n')
      thinkingShown = false
      break
    case 'thinking_delta':
      if (!thinkingShown) {
        write(`  ${c.dim('⋯ 思考中')}\n`)
        thinkingShown = true
      }
      break
    case 'text_delta':
      write(e.delta)
      break
    case 'tool_start': {
      toolStartedAt.set(e.callId, Date.now())
      const input = (e.input ?? {}) as Record<string, unknown>
      const arg = typeof input.command === 'string' ? short(input.command)
        : typeof input.path === 'string' ? String(input.path)
        : e.name === 'task' && typeof input.label === 'string' ? `子任务「${input.label}」${typeof input.prompt === 'string' ? ` · ${short(input.prompt, 60)}` : ''}`
        : ''
      write(`  ${c.cyan('⏺ ' + e.name)} ${c.dim(arg)}\n`)
      break
    }
    case 'tool_end': {
      const started = toolStartedAt.get(e.message.toolCallId)
      toolStartedAt.delete(e.message.toolCallId)
      const ms = started ? Date.now() - started : 0
      const mark = e.message.isError ? c.red('✗') : c.green('✓')
      const extra = metaLine(e.message)
      write(`    ${mark} ${e.message.name}${extra ? c.dim(` · ${extra}`) : ''}${c.dim(` · ${(ms / 1000).toFixed(1)}s`)}\n`)
      break
    }
    case 'assistant_end': {
      const m = e.message as AssistantMessage
      const usage = m.usage ? c.dim(` · in ${m.usage.input} / out ${m.usage.output}`) : ''
      if (m.stopReason === 'error') write(`\n  ${c.red('本轮出错：' + (m.error ?? '').split('\n')[0])}\n`)
      write(`\n${c.dim(`  π ${m.model}${usage}`)}\n\n`)
      break
    }
    case 'steering_queued':
      write(`  ${c.dim(`↳ 已排队（第 ${e.pending} 条，当前步骤结束后注入）`)}\n`)
      break
    case 'subagent_tool':
      // 子任务进度：否则长任务只有一个 spinner，像卡死
      if (e.phase === 'start') write(`    ${c.dim(`↳ [${e.label}] ${e.name}…`)}\n`)
      break
    case 'notice':
      write(`  ${c.yellow('! ' + e.text.replace(/\n/g, ' '))}\n`)
      break
    case 'run_end': {
      sigintPending = false
      if (e.status === 'aborted') write(`  ${c.yellow('已中止')}\n`)
      if (runningIds.size === 0) rlRef?.prompt()
      break
    }
    default:
      break
  }
}

/* ---------------- 斜杠命令 ---------------- */

const HELP = [
  '/help              显示本帮助',
  '/new [目录]        新建会话（不传目录则自动创建）',
  '/sessions          列出全部会话',
  '/switch <编号|id>  切换会话',
  '/model             查看当前模型与全部候选',
  '/model use <档案id> <模型名>  绑定本会话模型',
  '/thinking <low|high|max|reset>  设置思考强度',
  '/compact           压缩上下文：当前分支总结成摘要，切到摘要新分支（原分支保留）',
  '/login [档案id]    OpenAI OAuth 登录（ChatGPT 订阅，默认 openai-codex）',
  '/logout [档案id]   清除 OAuth 登录',
  '/attach <文件>     给下一条消息带附件（图片 ≤10MB，文本 ≤256KB，一条消息最多 8 个）',
  '/export [md|json]  导出当前会话运行轨迹',
  '/memory            显示记忆文件位置（内容由模型通过 memory 工具维护）',
  '/tools             列出可用工具',
  '/quit              退出（Ctrl+D 同效；运行中 Ctrl+C 只中止当前任务）'
].join('\n')

/** 解析 /login、/logout 的档案参数：不传时优先 openai-codex，其次当前激活档案 */
function oauthProfileId(arg: string | undefined): string {
  if (arg) return arg
  const cfg = config.load()
  return config.profileById('openai-codex') ? 'openai-codex' : cfg.activeProfileId
}

/** OAuth 登录：授权 URL 直接打印（多数终端可点击），本地回调服务等浏览器带回 code 换 token */
async function runLogin(): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number; account?: string }> {
  const login = startLogin({
    timeoutMs: 300_000,
    open: (url) => {
      write(`  ${c.cyan('请在浏览器打开并完成授权：')}\n  ${c.dim(url)}\n  ${c.dim('（本地回调端口 1455，登录成功后自动继续）')}\n`)
    }
  })
  return login.promise
}

function currentView(): { model: string; thinking: string; title: string } {
  const cfg = config.load()
  const meta = sessions.meta(sessionId)
  const profile = (meta.profileId ? config.profileById(meta.profileId) : undefined) ?? config.activeProfile()
  const model = meta.model?.trim() || cfg.model || '（未选择）'
  const thinking = meta.thinking ?? cfg.thinking
  return { model: `${profile.label} · ${model}`, thinking, title: sessions.view(sessionId).title }
}

/** 命令队列：保证多条命令按到达顺序逐个执行，不互相拦截 */
const commandQueue: string[] = []
let draining = false

async function drainCommands(): Promise<void> {
  if (draining) return
  draining = true
  while (commandQueue.length) {
    const cmd = commandQueue.shift()!
    try {
      await handleCommand(cmd)
    } catch (err) {
      write(`${c.red((err as Error).message)}\n`)
    }
  }
  draining = false
  rlRef?.prompt()
}

async function handleCommand(line: string): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ')

  switch (cmd) {
    case 'help':
      write(HELP + '\n')
      return true
    case 'new': {
      if (isRunning()) write(`  ${c.yellow('注意：上一个任务仍在后台运行，Ctrl+C 可中止。')}\n`)
      const dir = arg ? resolve(arg) : ''
      const meta = sessions.create(dir, { profileId: config.load().activeProfileId, model: config.load().model })
      sessionId = meta.id
      config.setLastSession(meta.id)
      pendingAttachments = undefined
      write(`${c.green('已创建会话')} ${meta.id}${dir ? `（目录 ${dir}）` : c.dim('（首次运行时自动创建目录）')}\n`)
      return true
    }
    case 'sessions': {
      const list = sessions.list()
      if (!list.length) write('还没有会话。\n')
      list.forEach((s, i) => {
        const mark = s.id === sessionId ? c.green('›') : ' '
        write(`${mark} ${i + 1}. ${s.title || '未命名会话'} ${c.dim(`(${s.id} · ${s.messageCount} 条${s.pinned ? ' · 置顶' : ''})`)}\n`)
      })
      return true
    }
    case 'switch': {
      if (!arg) {
        write('用法：/switch <编号|id>，先 /sessions 看编号。\n')
        return true
      }
      const list = sessions.list()
      const target = /^\d+$/.test(arg) ? list[Number(arg) - 1] : list.find((s) => s.id === arg)
      if (!target) {
        write(`${c.red('没有这个会话：' + arg)}\n`)
        return true
      }
      if (target.id !== sessionId && runningIds.has(sessionId)) {
        write(`  ${c.yellow('注意：原会话的任务仍在后台运行，事件不再显示；Ctrl+C 可中止。')}\n`)
      }
      sessionId = target.id
      config.setLastSession(target.id)
      // 附件暂存与旧会话绑定，切换时清掉，避免带到新会话
      pendingAttachments = undefined
      write(`${c.green('已切换')}：${target.title || target.id}\n`)
      return true
    }
    case 'login': {
      const id = oauthProfileId(rest[0])
      const profile = config.profileById(id)
      if (!profile) {
        write(`${c.red('档案不存在：' + id)}（/model 查看全部档案 id）\n`)
        return true
      }
      write(`${c.dim('发起 OpenAI OAuth 登录…在浏览器完成授权后回到这里。')}\n`)
      try {
        const tokens = await runLogin()
        config.setOAuth(id, tokens)
        write(`${c.green('已登录')}「${profile.label}」${tokens.account ? c.dim(` · ${tokens.account}`) : ''}\n`)
        write(c.dim('现在可用 /model use ' + id + ' <模型名> 绑定模型（gpt-5.2-codex 等）。\n'))
      } catch (err) {
        write(`${c.red('登录失败：' + (err as Error).message)}\n`)
      }
      return true
    }
    case 'logout': {
      const id = oauthProfileId(rest[0])
      if (!config.oauthFor(id)) {
        write(`${c.dim('该档案没有存过 OAuth 登录。')}\n`)
        return true
      }
      config.clearOAuth(id)
      write(`${c.green('已退出登录')}：${id}\n`)
      return true
    }
    case 'model': {
      if (rest[0] === 'use') {
        const [, profileId, model] = rest
        try {
          sessions.setModel(sessionId, profileId ?? '', model ?? '')
          const view = currentView()
          write(`${c.green('本会话模型已绑定为')} ${view.model}\n`)
        } catch (err) {
          write(`${c.red((err as Error).message)}\n`)
        }
        return true
      }
      const cfg = config.load()
      const view = currentView()
      write(`当前：${c.bold(view.model)} · 思考 ${view.thinking}\n`)
      for (const p of cfg.profiles) {
        write(`  ${p.id} ${c.dim(`(${p.protocol} · ${p.baseUrl})`)}\n`)
        for (const m of p.models ?? []) write(`    ${m.id}${m.maxOutput ? c.dim(` · out ${m.maxOutput}`) : ''}\n`)
        if (!p.models?.length) write(c.dim('    （未读取模型列表，桌面版设置里可读取）') + '\n')
      }
      return true
    }
    case 'thinking': {
      const level = rest[0]
      if (!['low', 'high', 'max', 'reset'].includes(level)) {
        write('用法：/thinking low|high|max|reset\n')
        return true
      }
      sessions.setThinking(sessionId, level === 'reset' ? undefined : (level as 'low' | 'high' | 'max'))
      write(`${c.green('思考强度')}：${currentView().thinking}\n`)
      return true
    }
    case 'attach': {
      if (!arg) {
        write('用法：/attach <文件路径>\n')
        return true
      }
      if ((pendingAttachments?.length ?? 0) >= MAX_ATTACHMENTS) {
        write(`${c.red(`一条消息最多 ${MAX_ATTACHMENTS} 个附件，先发送或减少附件。`)}\n`)
        return true
      }
      const file = resolve(arg)
      if (!existsSync(file)) {
        write(`${c.red('文件不存在：' + file)}\n`)
        return true
      }
      const name = basename(file)
      const mime = pickMime(name)
      const limit = attachmentLimit(name, mime)
      const bytes = readFileSync(file)
      if (bytes.byteLength > limit) {
        write(`${c.red(`「${name}」超过 ${limit === MAX_IMAGE_BYTES ? '10MB' : '256KB'} 上限`)}\n`)
        return true
      }
      const att = stageAttachment(sessionId, name, mime, new Uint8Array(bytes))
      pendingAttachments = [...(pendingAttachments ?? []), att]
      write(`${c.green('已添加附件')}：${name}（${pendingAttachments.length}/${MAX_ATTACHMENTS}，发送时随下一条消息带上）\n`)
      return true
    }
    case 'export': {
      const format = rest[0] === 'json' ? 'json' : 'md'
      const traj = buildTrajectory(sessions, sessionId)
      const safeTitle = (traj.title || 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 50)
      let out = join(process.cwd(), `trajectory-${safeTitle}.${format}`)
      // 同名文件不直接覆盖：追加毫秒时间戳，避免误删之前的导出
      if (existsSync(out)) out = join(process.cwd(), `trajectory-${safeTitle}-${Date.now()}.${format}`)
      writeFileSync(out, format === 'json' ? JSON.stringify(traj, null, 2) : trajectoryToMarkdown(traj), 'utf8')
      write(`${c.green('轨迹已导出')}：${out}\n`)
      return true
    }
    case 'compact': {
      if (isRunning()) {
        write(`${c.yellow('任务运行中，请等结束后再压缩。')}\n`)
        return true
      }
      write(c.dim('正在压缩上下文（总结当前分支）…\n'))
      try {
        await runner.compact(sessionId)
      } catch (err) {
        write(`${c.red('压缩失败：' + (err as Error).message)}\n`)
      }
      return true
    }
    case 'memory':
      write(`${c.dim('记忆文件：' + paths.memory())}\n${c.dim('内容由模型通过 memory 工具维护；图谱与全息元数据在同目录 JSON 里。')}\n`)
      return true
    case 'tools': {
      const { toolSpecs } = await import('../main/agent/tools')
      write(`可用工具：${toolSpecs().map((t) => t.name).join(', ')}\n`)
      return true
    }
    case 'quit':
    case 'exit':
      write(c.dim('再见。\n'))
      // 退出前停掉所有任务，避免留下失联的 bash 子进程
      runner.abortAll()
      exitSoon(0)
      return true
    default:
      write(`${c.red('未知命令：' + cmd)}（/help 查看全部）\n`)
      return true
  }
}

/* ---------------- REPL ---------------- */

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    write(
      'Metis 终端版 — 纯 Node REPL 编码代理\n\n' +
        '用法: pi [--new] [--session <id>] [--dir <目录>] [--home <数据目录>]\n\n' +
        HELP +
        '\n'
    )
    exitSoon(0)
    return
  }
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  // 认不出的启动参数直接点名，避免拼错时被静默忽略
  const KNOWN_FLAGS = new Set(['--new', '--session', '--dir', '--home', '--help', '-h'])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--') && !/^-h$/.test(a)) continue
    if (KNOWN_FLAGS.has(a)) {
      if (a === '--session' || a === '--dir' || a === '--home') i++ // 跳过参数值
      continue
    }
    write(`${c.yellow(`忽略未知参数：${a}（--help 查看用法）`)}\n`)
  }
  initPaths(get('--home') || undefined)
  // 终端版没有 Electron 的 safeStorage，直接用本地混淆保底
  config = new ConfigStore(fallbackSecretBox, paths.config())
  sessions = new SessionStore(paths.sessions())

  pluginHost.reload()
  runner = new AgentRunner(sessions, config, logger, (e) => {
    renderEvent(e)
  })

  // 选定起始会话：--session 指定 > 上次使用的 > 最新的 > 新建
  const list = sessions.list()
  const wanted = get('--session')
  const cfg = config.load()
  if (args.includes('--new')) {
    // --new：强制新会话（可选 --dir 指定目录）
    const dir = get('--dir') ? resolve(get('--dir')!) : ''
    sessionId = sessions.create(dir, { profileId: cfg.activeProfileId, model: cfg.model }).id
  } else if (wanted && sessions.exists(wanted)) {
    sessionId = wanted
  } else if (cfg.lastSessionId && list.some((s) => s.id === cfg.lastSessionId)) {
    sessionId = cfg.lastSessionId
  } else if (list.length) {
    sessionId = list[0].id
  } else {
    const dir = get('--dir') ? resolve(get('--dir')!) : ''
    sessionId = sessions.create(dir, { profileId: cfg.activeProfileId, model: cfg.model }).id
  }
  config.setLastSession(sessionId)

  const view = currentView()
  write(`${c.bold('metis')} 终端版 ${c.dim(`· ${view.model} · 思考 ${view.thinking}`)}\n`)
  write(`${c.dim(`会话：${sessions.view(sessionId).title || sessionId} · /help 查看命令`)}\n\n`)

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.cyan('› ') })
  rlRef = rl
  rl.prompt()

  rl.on('line', (line) => {
    const text = line.trim()
    // 清掉已打印的提示符行，让输出从行首开始（管道输出时是 no-op）
    if (isTTY) write('\r\x1b[K')
    if (!text) {
      rl.prompt()
      return
    }
    if (text.startsWith('/')) {
      // 同一批 stdin 里可能连续到达多条命令（readline 同步逐行 emit）：
      // 不能用 busy 丢弃，否则后面的命令凭空消失——入队逐个执行
      commandQueue.push(text)
      void drainCommands()
      return
    }

    const attachments = pendingAttachments
    pendingAttachments = undefined
    try {
      runner.send(sessionId, text, attachments)
    } catch (err) {
      write(`${c.red('发送失败：' + (err as Error).message)}\n`)
      rl.prompt()
    }
    // run 结束后由 run_end 事件恢复提示符；这里不阻塞读行（运行中输入 = steering 排队）
  })

  rl.on('SIGINT', () => {
    if (isRunning()) {
      // 第二次 Ctrl+C 强制退出：防止 provider 挂起（idle 看门狗）时永远退不出去
      if (sigintPending) {
        write(c.dim('\n强制退出。\n'))
        exitSoon(130)
        return
      }
      sigintPending = true
      // 可能已经 /switch 到别的会话：中止全部，保证没有失联的 run
      runner.abortAll()
      write(`  ${c.yellow('正在中止运行中的任务…（再按一次 Ctrl+C 强制退出）')}\n`)
      return
    }
    write(c.dim('\n再见。\n'))
    runner.abortAll()
    exitSoon(0)
  })

  rl.on('close', () => {
    if (isRunning()) {
      // Ctrl+D / 输入流关闭：任务还在跑，提示后等它自然结束（事件循环排空后进程自行退出）
      write(c.dim('\n（输入流已关闭；任务仍在运行，结束后自动退出）\n'))
      return
    }
    write(c.dim('\n再见。\n'))
    runner.abortAll()
    exitSoon(0)
  })
}

main().catch((err) => {
  console.error('启动失败：', err)
  logger.close()
  process.exit(1)
})
