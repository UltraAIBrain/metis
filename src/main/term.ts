import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TermEvent, TermShellKind } from '@shared/types'

/**
 * 面板内嵌终端：每个会话一个持久 shell 子进程，stdio 管道流式转发。
 *
 * 没有引入 node-pty（保持零原生依赖），因此是"行式终端"：
 * 日常命令（构建、测试、git、ls）完全可用；全屏交互程序（vim 等）不可用。
 * 进程按会话常驻（保留 cd 状态与历史），输出在主进程维护环形缓冲，
 * 切换面板 / 切换会话回来时历史不丢。事件经 IPC.termEvent 推给渲染层。
 *
 * 编码：Windows 上把控制台代码页与 PowerShell 的 Console 编码统一切到 UTF-8，
 * native 程序输出与 PowerShell 自身输出才不会在中文上打架；
 * Node 侧用 StringDecoder 拼字节，避免 chunk 边界切断多字节字符。
 */

/** 每个会话保留的输出缓冲（字符数），超出丢最旧的 */
const MAX_BUFFER_CHARS = 200_000

interface TermProc {
  child: ChildProcess
  buffer: string
  alive: boolean
  shellKind: Exclude<TermShellKind, 'auto'>
  /** 跨 chunk 的不完整 UTF-8 尾字节（多字节字符被 chunk 边界切断时缓存） */
  outTail: Buffer
  errTail: Buffer
  /** 输出侧的 GBK 连续态：一旦某个 chunk 判定为 GBK，后续同源 chunk 也按 GBK 解（中英混排不来回跳） */
  gbkMode: boolean
}

const SHELL_KINDS: Exclude<TermShellKind, 'auto'>[] = ['powershell', 'pwsh', 'cmd', 'bash']

/** Windows Terminal 新装机默认的 PowerShell 7；存在则优先于老版 powershell。
 *  覆盖两种安装：Program Files 常规安装 + Microsoft Store 版（WindowsApps 执行别名）。
 *  Store 别名是 reparse point，stat 会 EACCES 导致 existsSync 误报不存在，需单独探测。 */
function probeExists(p: string): boolean {
  if (existsSync(p)) return true
  try {
    statSync(p)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EACCES' // 别名存在但拒绝 stat
  }
}

function pwshPath(): string | null {
  if (process.platform !== 'win32') return null
  const root = process.env['ProgramFiles'] || 'C:\\Program Files'
  const localAppData = process.env['LOCALAPPDATA'] || ''
  for (const p of [
    join(root, 'PowerShell', '7', 'pwsh.exe'),
    join(root, 'PowerShell', '7-preview', 'pwsh.exe'),
    ...(localAppData ? [join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : [])
  ]) {
    if (probeExists(p)) return p
  }
  return null
}

/** PowerShell（5.1 与 7 同语法）的编码 preamble：全部切到 UTF-8，失败逐项忽略 */
const PS_PREAMBLE = [
  'chcp 65001 > $null',
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  'try { [Console]::InputEncoding=[System.Text.Encoding]::UTF8 } catch {}',
  '$OutputEncoding=[System.Text.Encoding]::UTF8'
].join('; ')

/** 各 shell 的启动横幅（管道模式没有真实 banner，合成一行保持整洁，参考真实终端的样子） */
function shellBanner(kind: Exclude<TermShellKind, 'auto'>): string {
  if (kind === 'pwsh') return 'PowerShell 7（pwsh）'
  if (kind === 'powershell') return 'Windows PowerShell 5.1'
  if (kind === 'cmd') return 'Windows cmd'
  return 'bash'
}

/** 严格 UTF-8 失败时按 GBK 解码（启动早期 shell 可能仍用系统代码页输出，比如 PSReadline 的警告） */
const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const gbkDecoder = new TextDecoder('gbk')

/** 缓冲区末尾不完整的 UTF-8 多字节序列长度（0-3），跨 chunk 拼字用 */
function incompleteTailLen(buf: Buffer): number {
  for (let i = Math.max(0, buf.length - 3); i < buf.length; i++) {
    const b = buf[i]
    if (b >= 0xc2 && b <= 0xdf && buf.length - i < 2) return buf.length - i
    if (b >= 0xe0 && b <= 0xef && buf.length - i < 3) return buf.length - i
    if (b >= 0xf0 && b <= 0xf4 && buf.length - i < 4) return buf.length - i
  }
  return 0
}

function shellSpawnEnv(): NodeJS.ProcessEnv {
  // PSModulePath 摘掉：父进程（IDE/终端宿主）给的模块路径会让 PowerShell 模块解析错乱
  const env = { ...process.env }
  delete env.PSModulePath
  return env
}

function shellCommand(kind: Exclude<TermShellKind, 'auto'>): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    if (kind === 'cmd') {
      return { file: 'cmd.exe', args: ['/k', 'chcp 65001 >nul'] }
    }
    if (kind === 'bash') {
      return { file: 'bash.exe', args: ['-i'] }
    }
    const file = kind === 'pwsh' ? pwshPath() ?? 'powershell.exe' : 'powershell.exe'
    // -Command 执行完编码设置后留在交互提示符
    return { file, args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', PS_PREAMBLE] }
  }
  // macOS / Linux：用用户的登录 shell（尊重 chsh 的默认 shell），保留 rc 配置
  return { file: process.env.SHELL || '/bin/bash', args: ['-i'] }
}

function resolveKind(kind: TermShellKind): Exclude<TermShellKind, 'auto'> {
  if (kind !== 'auto') return kind
  if (process.platform === 'win32') return pwshPath() ? 'pwsh' : 'powershell'
  return 'bash'
}

function isShellKind(v: unknown): v is Exclude<TermShellKind, 'auto'> {
  return typeof v === 'string' && (SHELL_KINDS as string[]).includes(v)
}

class TermHost {
  private procs = new Map<string, TermProc>()
  /** 渲染层事件出口；registerIpc 时绑定 */
  private emit: (sessionId: string, event: TermEvent) => void = () => {}

  bind(emit: (sessionId: string, event: TermEvent) => void): void {
    this.emit = emit
  }

  /** 智能解码：正常按流式 UTF-8；启动早期 shell 可能仍用系统代码页（GBK）输出，
   *  严格 UTF-8 解不过的 chunk 回退 GBK（一旦回退，该流后续都按 GBK，避免中英混排来回跳）；
   *  仍解不出的字符替换为空而不是乱码方块。 */
  private decodeChunk(proc: TermProc, buf: Buffer, isErr: boolean): string {
    const tailBuf = isErr ? proc.errTail : proc.outTail
    const combined = tailBuf.length ? Buffer.concat([tailBuf, buf]) : buf
    if (tailBuf.length) {
      if (isErr) proc.errTail = Buffer.alloc(0)
      else proc.outTail = Buffer.alloc(0)
    }
    let body = combined
    const tailLen = incompleteTailLen(combined)
    if (tailLen > 0) {
      body = combined.subarray(0, combined.length - tailLen)
      const kept = Buffer.from(combined.subarray(combined.length - tailLen))
      if (isErr) proc.errTail = kept
      else proc.outTail = kept
    }
    if (!body.length) return ''
    let text: string
    if (proc.gbkMode) {
      text = gbkDecoder.decode(body)
    } else {
      try {
        text = utf8Strict.decode(body)
      } catch {
        text = gbkDecoder.decode(body)
        proc.gbkMode = true
      }
    }
    // 解不出来的字符直接丢弃，不渲染成乱码方块
    return text.replace(/\uFFFD/g, '')
  }

  private push(sessionId: string, proc: TermProc, data: string): void {
    // 实例守卫：重启后旧 shell 被异步 taskkill，它临死前的输出不能混进新终端的缓冲
    if (this.procs.get(sessionId) !== proc) return
    proc.buffer += data
    if (proc.buffer.length > MAX_BUFFER_CHARS) {
      proc.buffer = proc.buffer.slice(proc.buffer.length - MAX_BUFFER_CHARS)
    }
    this.emit(sessionId, { type: 'data', sessionId, data })
  }

  /** 启动（或复用）会话的终端，返回当前历史缓冲；cwd 不存在时报错 */
  spawn(sessionId: string, cwd: string, rawKind: TermShellKind = 'auto'): string {
    const existing = this.procs.get(sessionId)
    if (existing && existing.alive) return existing.buffer
    if (existing) this.procs.delete(sessionId)
    if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`)

    const shellKind = isShellKind(rawKind) ? rawKind : resolveKind('auto')
    const { file, args } = shellCommand(shellKind)
    // 合成启动横幅（管道模式 shell 不打真实 banner）：一行版本 + 交给 shell 自己的提示符
    // child 在下方启动，这里先占位、spawn 后立即回填
    const proc: TermProc = {
      child: null as unknown as ChildProcess,
      buffer: `${shellBanner(shellKind)}\r\n`,
      alive: true,
      shellKind,
      outTail: Buffer.alloc(0),
      errTail: Buffer.alloc(0),
      gbkMode: false
    }
    this.procs.set(sessionId, proc)

    const child = spawn(file, args, { cwd, windowsHide: true, env: shellSpawnEnv() })

    proc.child = child

    child.stdout?.on('data', (d: Buffer) => this.push(sessionId, proc, this.decodeChunk(proc, d, false)))
    child.stderr?.on('data', (d: Buffer) => this.push(sessionId, proc, this.decodeChunk(proc, d, true)))
    child.on('error', (err) => {
      proc.alive = false
      /* 只有"仍是当前注册实例"才上报退出：被 kill/替换的旧 shell 迟到的 exit/error
         不能把刚重启的新终端标记为已退出（Windows 上 taskkill 是异步的，必然迟到） */
      if (this.procs.get(sessionId) !== proc) return
      this.push(sessionId, proc, `\r\n[终端启动失败：${err.message}]\r\n`)
      this.emit(sessionId, { type: 'exit', sessionId })
    })
    child.on('exit', () => {
      if (!proc.alive) return
      proc.alive = false
      if (this.procs.get(sessionId) !== proc) return
      this.push(sessionId, proc, '\r\n[终端已退出]\r\n')
      this.emit(sessionId, { type: 'exit', sessionId })
    })
    return proc.buffer
  }

  /** 当前会话终端用的 shell 类型（渲染层重启时保持一致） */
  kindOf(sessionId: string): Exclude<TermShellKind, 'auto'> {
    return this.procs.get(sessionId)?.shellKind ?? resolveKind('auto')
  }

  /** 写入一行命令（进程退出后报错，由界面提示重启） */
  write(sessionId: string, line: string): void {
    const proc = this.procs.get(sessionId)
    if (!proc || !proc.alive) throw new Error('终端已退出，请先重启')
    proc.child.stdin?.write(`${line}\n`)
  }

  data(sessionId: string): string {
    return this.procs.get(sessionId)?.buffer ?? ''
  }

  alive(sessionId: string): boolean {
    return this.procs.get(sessionId)?.alive ?? false
  }

  kill(sessionId: string): void {
    const proc = this.procs.get(sessionId)
    if (!proc) return
    /* 先标记死亡并注销，再杀进程树：taskkill 是异步的，旧 shell 的 exit 事件
       会在新 shell 启动后才到达，上面 spawn 里的"仍是当前实例"守卫靠这一步生效 */
    proc.alive = false
    this.procs.delete(sessionId)
    try {
      if (process.platform === 'win32' && proc.child.pid) {
        // shell 里可能跑着用户命令的子进程，杀整棵树而不是只杀 shell 本体
        spawn('taskkill', ['/pid', String(proc.child.pid), '/T', '/F'], { windowsHide: true })
      } else {
        proc.child.kill()
      }
    } catch {
      /* 已退出 */
    }
  }

  killAll(): void {
    for (const id of [...this.procs.keys()]) this.kill(id)
  }
}

export const termHost = new TermHost()
