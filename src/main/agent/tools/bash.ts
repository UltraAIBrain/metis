import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ShellKind } from '@shared/types'
import type { AgentTool, ToolResult } from './types'
import { asOptionalNumber, asString, ToolError } from './util'

const MAX_OUTPUT_BYTES = 200_000
const DEFAULT_TIMEOUT_SEC = 120
const MAX_TIMEOUT_SEC = 600

interface ShellPlan {
  mode: 'encoded' | 'shell'
  file: string
  args: string[]
}

function systemPowerShell(): string | null {
  const root = process.env.SystemRoot || 'C:\\Windows'
  const p = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(p) ? p : null
}

/**
 * Windows 下用 -EncodedCommand 传递脚本，彻底绕开引号转义问题；
 * 同时把控制台输出编码固定为 UTF-8，避免中文乱码。
 */
function planFor(kind: ShellKind, command: string): ShellPlan {
  const isWin = process.platform === 'win32'
  const resolved: Exclude<ShellKind, 'auto'> =
    kind === 'auto' ? (isWin ? (systemPowerShell() ? 'powershell' : 'cmd') : 'bash') : kind

  if (resolved === 'powershell') {
    if (!isWin) throw new ToolError('当前系统不支持 powershell，请把 shell 配置改为 bash')
    const exe = systemPowerShell() ?? 'powershell.exe'
    const preamble = [
      "$ErrorActionPreference='Continue'",
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
      '$OutputEncoding=[System.Text.Encoding]::UTF8'
    ].join('\n')
    const script = `${preamble}\n${command}\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 }`
    return {
      mode: 'encoded',
      file: exe,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    }
  }

  if (resolved === 'cmd') {
    if (!isWin) throw new ToolError('cmd 仅在 Windows 可用')
    return { mode: 'shell', file: 'cmd.exe', args: [] }
  }

  return { mode: 'shell', file: isWin ? 'bash.exe' : '/bin/bash', args: [] }
}

/**
 * 传给子进程的环境变量：剔除名字里带密钥特征的变量（API key、token 等），
 * 避免 `env` / `printenv` 之类命令把凭据原样暴露给模型。
 */
function shellEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue
    out[k] = v
  }
  return out
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      killer.once('error', () => {
        try {
          child.kill()
        } catch {
          /* 已退出 */
        }
      })
    } catch {
      child.kill()
    }
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

export const bashTool: AgentTool = {
  spec: {
    name: 'bash',
    description:
      '在工作目录中执行 shell 命令，返回 stdout / stderr 与退出码。' +
      '用于列目录、搜索、运行测试与构建等——不需要为文件系统操作单独找工具。' +
      '注意：命令无交互式终端，不要运行需要用户输入的命令。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令' },
        timeout: { type: 'number', description: `超时秒数，默认 ${DEFAULT_TIMEOUT_SEC}，最大 ${MAX_TIMEOUT_SEC}` }
      },
      required: ['command'],
      additionalProperties: false
    }
  },

  async run(input, ctx): Promise<ToolResult> {
    const command = asString(input, 'command', { required: true })
    const timeoutSec = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.floor(asOptionalNumber(input, 'timeout') ?? DEFAULT_TIMEOUT_SEC)))
    if (ctx.signal.aborted) return { content: '已中止', isError: true }

    const plan = planFor(ctx.shell, command)
    const started = Date.now()

    return await new Promise<ToolResult>((resolve) => {
      let child: ChildProcess
      try {
        child =
          plan.mode === 'encoded'
            ? spawn(plan.file, plan.args, { cwd: ctx.workspace, windowsHide: true, env: shellEnv() })
            : spawn(command, { cwd: ctx.workspace, shell: plan.file, windowsHide: true, env: shellEnv() })
      } catch (err) {
        resolve({ content: `Error: 无法启动 shell：${(err as Error).message}`, isError: true })
        return
      }

      const chunks: Buffer[] = []
      let bytes = 0
      let truncated = false
      let timedOut = false
      let settled = false

      const append = (b: Buffer): void => {
        if (bytes + b.length > MAX_OUTPUT_BYTES) {
          const room = MAX_OUTPUT_BYTES - bytes
          if (room > 0) chunks.push(b.subarray(0, room))
          bytes = MAX_OUTPUT_BYTES
          truncated = true
          return
        }
        chunks.push(b)
        bytes += b.length
      }

      child.stdout?.on('data', append)
      child.stderr?.on('data', append)

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutSec * 1000)

      const onAbort = (): void => killTree(child)
      ctx.signal.addEventListener('abort', onAbort, { once: true })

      const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)

        const durationMs = Date.now() - started
        const output = Buffer.concat(chunks).toString('utf8').trimEnd()
        const aborted = ctx.signal.aborted

        if (spawnError) {
          resolve({ content: `Error: 命令执行失败：${spawnError.message}`, isError: true })
          return
        }

        const footerParts = [`exit ${code ?? 'killed'}`]
        if (signal) footerParts.push(`signal ${signal}`)
        if (timedOut) footerParts.push(`超时 ${timeoutSec}s 已终止`)
        if (aborted) footerParts.push('用户中止')
        if (truncated) footerParts.push(`输出已截断（上限 ${MAX_OUTPUT_BYTES / 1000}KB）`)
        footerParts.push(`${(durationMs / 1000).toFixed(1)}s`)

        const body = output || '(no output)'
        const isError = aborted || timedOut || (code !== null && code !== 0)
        ctx.log('tool.bash', { cmd: command.slice(0, 200), code, durationMs, truncated, timedOut, aborted })

        resolve({
          content: `${body}\n\n[${footerParts.join(' · ')}]`,
          isError,
          meta: { kind: 'bash', exitCode: code, durationMs, truncated, timedOut }
        })
      }

      child.on('error', (err) => finish(null, null, err))
      child.on('close', (code, signal) => finish(code, signal))
    })
  }
}
