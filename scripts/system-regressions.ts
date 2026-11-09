import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { TermShellKind } from '../src/shared/types'
import type { ScheduleTask } from '../src/main/scheduler'

/** 转译真实模块，仅替换进程/文件系统/时钟边界，跨平台测试不启动实际 shell。 */
function loadModule<T>(file: string, imports: Record<string, unknown>, globals: Record<string, unknown> = {}): T {
  const source = readFileSync(resolve('src/main', file), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText
  const exported = {}
  runInNewContext(code, {
    exports: exported, Buffer, TextDecoder,
    require: (name: string) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected module: ${name}`)
      return imports[name]
    },
    ...globals
  }, { filename: file })
  return exported as T
}

export function runSystemRegressions(): void {
  for (const scenario of [
    { platform: 'linux', shell: '/bin/zsh', kind: 'auto', expected: '/bin/zsh' },
    { platform: 'darwin', shell: '/bin/zsh', kind: 'auto', expected: '/bin/zsh' },
    { platform: 'linux', shell: '', kind: 'auto', expected: '/bin/bash' },
    { platform: 'win32', shell: '', kind: 'cmd', expected: 'cmd.exe' },
    { platform: 'win32', shell: '', kind: 'bash', expected: 'bash.exe' },
    { platform: 'win32', shell: '', kind: 'powershell', expected: 'powershell.exe' },
    { platform: 'win32', shell: '', kind: 'auto', expected: 'pwsh.exe' }
  ]) {
    const calls: { file: string; args: string[]; options: { cwd: string; windowsHide: boolean; env: Record<string, string> } }[] = []
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: { write: () => true }, kill: () => true
    })
    const { termHost } = loadModule<{ termHost: { spawn: (id: string, cwd: string, kind: TermShellKind) => string } }>('term.ts', {
      'node:child_process': { spawn: (file: string, args: string[], options: typeof calls[number]['options']) => {
        calls.push({ file, args, options })
        return child
      } },
      'node:fs': { existsSync: () => true, statSync: () => ({}) },
      'node:path': { join }
    }, { process: { platform: scenario.platform, env: {
      SHELL: scenario.shell, ProgramFiles: 'C:/Programs', PSModulePath: 'inherited modules'
    } } })
    termHost.spawn('s_terminal', '/workspace', scenario.kind as TermShellKind)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].file, scenario.expected)
    assert.equal(calls[0].options.cwd, '/workspace')
    assert.equal(calls[0].options.windowsHide, true)
    assert.equal(calls[0].options.env.PSModulePath, undefined)
    if (scenario.platform !== 'win32') assert.equal(calls[0].args.join(','), '-i')
    termHost.spawn('s_terminal', '/workspace', scenario.kind as TermShellKind)
    assert.equal(calls.length, 1, 'A live terminal should be reused')
  }
  console.log('  ✓ Linux/macOS 登录 shell 与默认值正确，Windows shell 和会话复用保持有效')

  let now = new Date(2026, 10, 9, 9, 0).getTime()
  const files = new Map<string, string>()
  let tick: (() => void) | undefined
  const sends: string[] = []
  class ClockDate extends Date {
    constructor() { super(now) }
    static override now(): number { return now }
  }
  const scheduler = loadModule<{
    bindScheduler: (runner: { send: (id: string) => { queued: boolean } }) => void
    createSchedule: (input: { name: string; prompt: string; cron: string; sessionId: string }) => ScheduleTask
    listSchedules: () => ScheduleTask[]
    startScheduler: () => void
    stopScheduler: () => void
  }>('scheduler.ts', {
    'node:fs': {
      existsSync: (file: string) => files.has(file),
      readFileSync: (file: string) => files.get(file),
      writeFileSync: (file: string, text: string) => files.set(file, text),
      renameSync: (from: string, to: string) => { files.set(to, files.get(from)!); files.delete(from) }
    },
    './paths': { paths: { memoryDir: () => '/test' } },
    './logger': { logger: { info: () => {}, warn: () => {} } },
    './agent/session': { assertSessionId: (id: string) => assert.match(id, /^s_[a-z0-9]+$/) }
  }, {
    Date: ClockDate,
    setInterval: (callback: () => void) => { tick = callback; return { unref: () => {} } },
    clearInterval: () => { tick = undefined }
  })
  scheduler.bindScheduler({ send: (id) => {
    sends.push(id)
    if (id === 's_deleted') throw new Error('Session no longer exists')
    return { queued: false }
  } })
  scheduler.createSchedule({ name: 'missing', prompt: 'run', cron: '* * * * *', sessionId: 's_deleted' })
  scheduler.createSchedule({ name: 'valid', prompt: 'run', cron: '* * * * *', sessionId: 's_valid' })
  scheduler.startScheduler()
  assert.deepEqual(sends, ['s_deleted', 's_valid'])
  assert.equal(scheduler.listSchedules().find((task) => task.sessionId === 's_deleted')?.enabled, false)
  assert.ok(tick)
  tick()
  assert.equal(sends.length, 2, 'A schedule must only fire once per minute')
  now += 60_000
  tick()
  assert.deepEqual(sends, ['s_deleted', 's_valid', 's_valid'])
  scheduler.stopScheduler()
  scheduler.startScheduler()
  assert.equal(sends.length, 3, 'Restart should preserve the last fired minute')
  scheduler.stopScheduler()
  console.log('  ✓ 失败任务禁用状态持久化，后续轮询/重启不重试，同分钟正常任务不重复')
}
