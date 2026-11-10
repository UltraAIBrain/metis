/**
 * 冒烟测试：不依赖任何真实 API Key。
 * 起一个本地 OpenAI 兼容的假模型服务，驱动完整代理循环，
 * 验证流式解析、四个工具、会话树分支、路径守卫与日志落盘。
 *
 *   npm run smoke
 */
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AssistantMessage, ToolMessage } from '../src/shared/types'

const home = mkdtempSync(join(tmpdir(), 'pidesktop-smoke-'))
const workspace = join(home, 'workspace')
mkdirSync(workspace, { recursive: true })
process.env.PI_DESKTOP_HOME = home
process.env.PI_LOG_LEVEL = 'info'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 造一个 store（不压缩）模式的 zip，用于验证解包逻辑，不依赖任何第三方库 */
function makeZip(files: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const file of files) {
    const data = Buffer.from(file.content, 'utf8')
    const name = Buffer.from(file.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // store
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0, 8)
    cen.writeUInt16LE(0, 10) // store
    cen.writeUInt32LE(0, 12)
    cen.writeUInt32LE(0, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(name.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)

    locals.push(local, name, data)
    central.push(cen, name)
    offset += 30 + name.length + data.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuf, eocd])
}

interface MockCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** 记录每个 /chat/completions 请求里带的 model，用于验证会话级模型选择 */
const seenModels: string[] = []
/** 记录每次请求带的 reasoning_effort，用于验证思考强度 */
const seenEffort: (string | undefined)[] = []
/** 记录每次请求带的 max_tokens */
const seenMaxTokens: (number | undefined)[] = []
const seenCompletionTokens: (number | undefined)[] = []
const seenTemperature: (number | undefined)[] = []
/** 记录每次请求最后一条 user 消息的内容（附件验证用） */
const seenLastUserContent: string[] = []
/** mock 当前在处理的请求并发峰值（验证子任务并行） */
let mockConcurrent = 0
let mockMaxConcurrent = 0
/** 最近一次请求的 system 注入内容与工具清单（验证记忆注入 / 子类型过滤） */
let seenSystemLast = ''
let seenSubToolNamesLast = ''
let subToolMaxLen = 0

const CALLS: MockCall[] = [
  { id: 'call_1', name: 'write', args: { path: 'demo/hello.txt', content: 'hello\nworld\n' } },
  { id: 'call_2', name: 'read', args: { path: 'demo/hello.txt' } },
  { id: 'call_3', name: 'edit', args: { path: 'demo/hello.txt', old_string: 'world', new_string: 'pi' } },
  { id: 'call_4', name: 'bash', args: { command: 'echo smoke-ok' } }
]

function startMockServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    /** 网络抖动模拟：mock-flaky 的前两次连接直接掐断 */
    let flakyHits = 0
    const server = createServer((req, res) => {
      // 模型列表接口：供 models 模块与"自动读取模型名"验证
      if (req.method === 'GET' && (req.url ?? '') === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              { id: 'mock-small', owned_by: 'smoke' },
              // 模拟 OpenRouter 那种带元数据的返回
              {
                id: 'mock-large',
                owned_by: 'smoke',
                context_length: 200000,
                top_provider: { max_completion_tokens: 64000 },
                architecture: { input_modalities: ['text', 'image'] }
              },
              { id: 'glm-5.3-flash', owned_by: 'smoke' }
            ]
          })
        )
        return
      }
      if (req.method === 'GET') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not found"}')
        return
      }

      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        mockConcurrent++
        mockMaxConcurrent = Math.max(mockMaxConcurrent, mockConcurrent)
        res.on('close', () => {
          mockConcurrent--
        })
        let assistantTurns = 0
        let promptTokens = 0
        let model0 = ''
        let effort0: string | undefined
        /** 请求体里是否带了对应标记（子智能体测试用） */
        let hasSubtaskMark = false
        let hasSubtaskBigMark = false
        let bigParentMark = false
        let hasSpawnMark = false
        let parallelMark = false
        let memoryMark = false
        let memRewriteMark = false
        let exploreMark = false
        let subReadOnly = false
        /** 历史里是否已经调过 memory 工具（rewrite 只做一次，否则就是无限循环） */
        let memoryCalled = false
        try {
          const parsed = JSON.parse(body || '{}')
          assistantTurns = (parsed.messages ?? []).filter((m: { role: string }) => m.role === 'assistant').length
          if (typeof parsed.model === 'string') {
            model0 = parsed.model
            seenModels.push(parsed.model)
          }
          effort0 = typeof parsed.reasoning_effort === 'string' ? parsed.reasoning_effort : undefined
          seenEffort.push(effort0)
          seenMaxTokens.push(typeof parsed.max_tokens === 'number' ? parsed.max_tokens : undefined)
          seenCompletionTokens.push(typeof parsed.max_completion_tokens === 'number' ? parsed.max_completion_tokens : undefined)
          seenTemperature.push(typeof parsed.temperature === 'number' ? parsed.temperature : undefined)
          const users = (parsed.messages ?? []).filter((m: { role: string }) => m.role === 'user')
          if (users.length) seenLastUserContent.push(JSON.stringify(users[users.length - 1].content))
          // 标记以"第一条 user 消息"为准：父会话后续轮次的历史里会出现带标记的工具参数，
          // 用全文匹配会把父请求误判成子请求
          // 以"最后一条 user 消息"判定标记：同一会话的后续请求里，第一条 user 还是老消息
          const lastUserText = users.length ? JSON.stringify(users[users.length - 1].content) : ''
          hasSubtaskMark = lastUserText.includes('SUBTASK-RUN-SMOKE')
          hasSubtaskBigMark = hasSubtaskMark && lastUserText.includes('SUBTASK-RUN-SMOKE-BIG')
          bigParentMark = lastUserText.includes('SUBTASK-BIG-SMOKE')
          hasSpawnMark = lastUserText.includes('SPAWN-SUBTASK-SMOKE')
          parallelMark = lastUserText.includes('PARALLEL-SUBTASKS-SMOKE')
          memoryMark = lastUserText.includes('MEMORY-TOOL-SMOKE')
          memRewriteMark = lastUserText.includes('MEMORY-REWRITE-SMOKE')
          exploreMark = lastUserText.includes('EXPLORE-SUBTASK-SMOKE')
          memoryCalled = (parsed.messages ?? []).some(
            (m: { tool_calls?: { function?: { name?: string } }[] }) =>
              Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.function?.name === 'memory')
          )
          // 记录 system 注入与工具清单（验证记忆注入 / 子类型工具过滤）
          const sys = (parsed.messages ?? []).find((m: { role: string }) => m.role === 'system')
          if (sys) seenSystemLast = JSON.stringify(sys.content)
          const tools = parsed.tools as { function?: { name?: string } }[] | undefined
          if (Array.isArray(tools)) {
            const names = tools.map((t) => t.function?.name ?? '').join(',')
            if (hasSubtaskMark) seenSubToolNamesLast = names
            subReadOnly = hasSubtaskMark && !names.split(',').includes('bash')
          }
          // 子请求历史里 tool 消息的最大 content 长度（验证子循环上下文不被落盘截断影响）
          if (hasSubtaskMark) {
            for (const m of parsed.messages ?? []) {
              if (m.role === 'tool') {
                const len = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length
                subToolMaxLen = Math.max(subToolMaxLen, len)
              }
            }
          }
          // 模拟一个"不认这个参数"的服务端：带去就 400，去掉就正常
          if (model0.includes('reject') && parsed.reasoning_effort) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'unsupported parameter: reasoning_effort' } }))
            return
          }
        } catch {
          /* ignore */
        }

        // 网络抖动模拟：mock-flaky 的前两次连接直接掐断（客户端会看到 ECONNRESET / 对端关闭），
        // 第三次正常响应——用来验证"一次抖动不再打死整个回合"
        if (model0.includes('flaky') && flakyHits < 2) {
          flakyHits++
          req.socket.destroy()
          return
        }

        // 上下文压缩请求（system 是压缩提示词）：直接回一份结构化摘要
        if (seenSystemLast.includes('会话压缩器')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(
            `data: ${JSON.stringify({
              choices: [
                { index: 0, delta: { content: '任务目标：跑通冒烟。已完成：全部改动。关键决策：保持极简。未完成：无。重要状态：工作目录就绪。' } }
              ]
            })}\n\n`
          )
          res.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 5 }
            })}\n\n`
          )
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const send = (obj: unknown): void => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`)
        }

        // 思考吃光输出额度的模型：高强度只回思维链，降到 low 才给正文
        if (model0 === 'glm-5.3-budget-eaten') {
          if (effort0 === 'low') {
            send({ choices: [{ index: 0, delta: { content: '降档之后正常输出。' } }] })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
          } else {
            send({ choices: [{ index: 0, delta: { reasoning_content: '想得太久…' } }] })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 推理模型把额度耗在思考上的情形：只有思维链，没有正文
        if (model0 === 'mock-reasoning-only') {
          send({ choices: [{ index: 0, delta: { reasoning_content: '先拆解需求…' } }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'length' } ] })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 回归：前 45 轮都由模型自己决定继续（旧版本 40 步就被截断），第 46 轮才收尾。
        // 循环的终止条件只能是「模型不再调用工具」，不能是步数。
        if (model0 === 'mock-longrun') {
          if (assistantTurns < 45) {
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_long_${assistantTurns}`,
                        type: 'function',
                        // 参数每轮变化：这个用例只验证「不截断」，重复检测交给 [13e]
                        function: {
                          name: 'read',
                          arguments: JSON.stringify({ path: 'demo/hello.txt', limit: 1 + (assistantTurns % 3) })
                        }
                      }
                    ]
                  }
                }
              ]
            })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            send({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 6 } })
          } else {
            send({ choices: [{ index: 0, delta: { content: '第 45 轮做完，没有步数上限。' } }] })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            send({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 10 } })
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 空转检测：每轮都发完全相同的 read(demo/hello.txt)，结果恒定不变。
        // 第 4 次与第 8 次各提醒一次；靠模型自己收尾，runner 不得中止（对齐 Codex / Claude Code）。
        if (model0 === 'mock-stuck') {
          if (assistantTurns < 10) {
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_stuck_${assistantTurns}`,
                        type: 'function',
                        function: { name: 'read', arguments: JSON.stringify({ path: 'demo/hello.txt' }) }
                      }
                    ]
                  }
                }
              ]
            })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            send({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 6 } })
          } else {
            send({ choices: [{ index: 0, delta: { content: '收到重复提醒，收尾。' } }] })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            send({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 8 } })
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 附件测试用：直接回文本，不调用工具
        // 预算提醒：每轮递增 prompt_tokens，配合 contextWindow=1000 逐档触发
        if (model0 === 'mock-budget') {
          if (assistantTurns < 5) {
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_budget_${assistantTurns}`,
                        type: 'function',
                        function: { name: 'read', arguments: JSON.stringify({ path: 'demo/hello.txt' }) }
                      }
                    ]
                  }
                }
              ]
            })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            send({ choices: [], usage: { prompt_tokens: 200 * (assistantTurns + 1), completion_tokens: 5 } })
          } else {
            send({ choices: [{ index: 0, delta: { content: '预算提醒收到，收尾。' } }] })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            send({ choices: [], usage: { prompt_tokens: 950, completion_tokens: 5 } })
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        if (model0 === 'mock-plain') {
          send({ choices: [{ index: 0, delta: { content: '收到。' } }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 子智能体分支：子任务的 user 消息带 SUBTASK-SMOKE 标记，mock 直接"执行"并汇报。
        // 同时证明工具循环真的在跑：普通子任务调 bash，只读子任务调 repomind。
        if (hasSubtaskMark && !hasSpawnMark) {
          if (assistantTurns === 0) {
            // 第一轮：调 bash 验证子智能体工具可用；带 BIG 标记时命令产生 >8KB 输出（验证落盘截断）
            const bigOut = hasSubtaskBigMark
            const bigCmd = `node -e "console.log('B'.repeat(9000))"`
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: bigOut ? 'call_big_1' : 'call_sub_1',
                        type: 'function',
                        function: subReadOnly
                          ? { name: 'repomind', arguments: JSON.stringify({ action: 'stats' }) }
                          : { name: 'bash', arguments: JSON.stringify({ command: bigOut ? bigCmd : 'echo sub-agent-ok' }) }
                      }
                    ]
                  }
                }
              ]
            })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            send({ choices: [], usage: { prompt_tokens: 90, completion_tokens: 15 } })
          } else {
            // 第二轮：拿到 bash 结果后汇报
            send({ choices: [{ index: 0, delta: { content: subReadOnly ? '只读子任务完成：已查看仓库结构。' : '子任务完成：bash 输出 sub-agent-ok。' } }] })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            send({ choices: [], usage: { prompt_tokens: 150, completion_tokens: 30 } })
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 并行子任务测试：父第一轮同时发两个 task 调用，验证 runner 的并行执行
        const parentParallelHit = assistantTurns === 0 && parallelMark && !hasSubtaskMark && !hasSpawnMark
        if (parentParallelHit) {
          send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: (['A', 'B'] as const).map((tag, i) => ({
                    index: i,
                    id: `call_par_${i + 1}`,
                    type: 'function',
                    function: {
                      name: 'task',
                      arguments: JSON.stringify({
                        prompt: `SUBTASK-RUN-SMOKE：任务${tag}，运行 echo sub-agent-ok 并汇报输出。`,
                        label: `并行子任务${tag}`
                      })
                    }
                  }))
                }
              }
            ]
          })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          send({ choices: [], usage: { prompt_tokens: 70, completion_tokens: 12 } })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 子智能体派生测试：父会话第一轮回 task 调用，第二轮回最终文本
        // 记忆测试：MEMORY-TOOL-SMOKE 触发 append；MEMORY-REWRITE-SMOKE 触发 rewrite（验证覆盖）
        if (memRewriteMark && !hasSubtaskMark) {
          // 只重写一次：拿到 rewrite 结果后就收尾。写成无条件返回工具调用会让
          // 模型永远"还有下一步"——那正是以前被 maxSteps 硬停掩盖掉的无限循环。
          if (!memoryCalled) {
            const memCall = { action: 'rewrite', content: '- 精简版记忆' }
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_mem_rw_1',
                        type: 'function',
                        function: { name: 'memory', arguments: JSON.stringify(memCall) }
                      }
                    ]
                  }
                }
              ]
            })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            send({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 8 } })
          } else {
            send({ choices: [{ index: 0, delta: { content: '记忆已重写。' } }] })
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
            send({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 6 } })
          }
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        if (memoryMark && !hasSubtaskMark && assistantTurns === 0) {
          const memCall = { action: 'append', content: '用户偏好：回复保持简洁（smoke 记忆）' }
          send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_mem_${assistantTurns + 1}`,
                      type: 'function',
                      function: { name: 'memory', arguments: JSON.stringify(memCall) }
                    }
                  ]
                }
              }
            ]
          })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          send({ choices: [], usage: { prompt_tokens: 60, completion_tokens: 8 } })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // explore 类型测试：父派生只读子智能体
        if (assistantTurns === 0 && exploreMark && !hasSubtaskMark) {
          send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_exp_1',
                      type: 'function',
                      function: {
                        name: 'task',
                        arguments: JSON.stringify({
                          prompt: 'SUBTASK-RUN-SMOKE：读一下工作目录结构并汇报。',
                          label: '只读调研',
                          type: 'explore'
                        })
                      }
                    }
                  ]
                }
              }
            ]
          })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          send({ choices: [], usage: { prompt_tokens: 65, completion_tokens: 9 } })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        // 大输出子任务：父派生一个会产生 >8KB bash 输出的子任务（验证落盘截断）
        if (assistantTurns === 0 && bigParentMark && !hasSubtaskMark) {
          send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_big_parent',
                      type: 'function',
                      function: {
                        name: 'task',
                        arguments: JSON.stringify({
                          prompt: 'SUBTASK-RUN-SMOKE-BIG：运行一条会产生超过 8KB 输出的命令并汇报。',
                          label: '大输出子任务'
                        })
                      }
                    }
                  ]
                }
              }
            ]
          })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          send({ choices: [], usage: { prompt_tokens: 75, completion_tokens: 11 } })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        const parentSpawnHit = assistantTurns === 0 && hasSpawnMark && !hasSubtaskMark
        if (parentSpawnHit) {
          send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_spawn_1',
                      type: 'function',
                      function: {
                        name: 'task',
                        arguments: JSON.stringify({
                          prompt: 'SUBTASK-RUN-SMOKE：运行 echo sub-agent-ok 并汇报输出。',
                          label: '冒烟子任务'
                        })
                      }
                    }
                  ]
                }
              }
            ]
          })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          send({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 10 } })
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }

        if (assistantTurns === 0) {
          send({ choices: [{ index: 0, delta: { role: 'assistant', content: '动手。' } }] })
          CALLS.forEach((call, index) => {
            const argStr = JSON.stringify(call.args)
            const mid = Math.floor(argStr.length / 2)
            // 故意把参数拆成两段，验证增量 tool_calls 拼接
            send({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      { index, id: call.id, type: 'function', function: { name: call.name, arguments: argStr.slice(0, mid) } }
                    ]
                  }
                }
              ]
            })
            send({
              choices: [
                { index: 0, delta: { tool_calls: [{ index, function: { arguments: argStr.slice(mid) } }] } }
              ]
            })
          })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 40 } })
        } else {
          promptTokens = 480
          send({ choices: [{ index: 0, delta: { content: '全部完成。`demo/hello.txt` 已改为 pi。' } }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
          send({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 18 } })
        }

        res.write('data: [DONE]\n\n')
        res.end()
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r()))
      })
    })
  })
}

async function main(): Promise<void> {
  const { initPaths, paths } = await import('../src/main/paths')
  initPaths(home)

  const { Logger } = await import('../src/main/logger')
  const { ConfigStore, fallbackSecretBox } = await import('../src/main/config')
  const { SessionStore, assertSessionId } = await import('../src/main/agent/session')
  const { AgentRunner } = await import('../src/main/agent/runner')
  const { createProvider } = await import('../src/main/agent/providers')
  const { executeTool, toolSpecs: toolsSpecs } = await import('../src/main/agent/tools')
  const { pluginHost } = await import('../src/main/plugins')
  const { unzip } = await import('../src/main/zip')
  const { parseGitHubUrl } = await import('../src/main/github')
  const { listModels } = await import('../src/main/models')
  const { detectPreset, inferProtocol, isLocalHost } = await import('../src/shared/providers')

  const mock = await startMockServer()
  const logger = new Logger('info')
  const config = new ConfigStore(fallbackSecretBox, paths.config())
  const sessions = new SessionStore(paths.sessions())

  config.patch({
    model: 'mock-model',
    shell: 'auto',
    activeProfileId: 'deepseek',
    profiles: [{ id: 'deepseek', protocol: 'openai', baseUrl: mock.url, apiKey: 'smoke-test-key' }]
  })

  console.log('\n[1] 代理循环 + 四个工具')
  const events: AgentEvent[] = []
  const runner = new AgentRunner(sessions, config, logger, (e) => events.push(e))
  const meta = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-model' })

  const runEnds = (): number => events.filter((e) => e.type === 'run_end').length
  const runOnce = async (id: string, text: string, attachments?: unknown): Promise<void> => {
    const before = runEnds()
    const done = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (runEnds() > before) {
          clearInterval(timer)
          resolve()
        }
      }, 20)
      setTimeout(() => {
        clearInterval(timer)
        resolve()
      }, 20_000)
    })
    runner.send(id, text, attachments)
    await done
  }

  await runOnce(meta.id, '创建 demo/hello.txt，把 world 改成 pi，再运行 echo')

  const file = join(workspace, 'demo', 'hello.txt')
  check('write 生效', existsSync(file))
  check('edit 生效', existsSync(file) && readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === 'hello\npi\n', existsSync(file) ? JSON.stringify(readFileSync(file, 'utf8')) : '文件缺失')

  const view = sessions.view(meta.id)
  const roles = view.messages.map((m) => m.role).join(',')
  check('消息结构完整', roles === 'user,assistant,tool,tool,tool,tool,assistant', roles)

  const toolMsgs = view.messages.filter((m) => m.role === 'tool')
  check('四个工具全部执行', toolMsgs.length === 4, `${toolMsgs.length}`)
  check('bash 输出正确', toolMsgs.some((m) => m.role === 'tool' && m.name === 'bash' && m.content.includes('smoke-ok')))
  check('工具参数已保留', toolMsgs.some((m) => m.role === 'tool' && m.input?.command === 'echo smoke-ok'))

  const last = view.messages[view.messages.length - 1]
  check('最终回答是文本', last.role === 'assistant' && last.blocks.some((b) => b.type === 'text' && b.text.includes('全部完成')))
  check('token 用量已记录', view.messages.some((m) => m.role === 'assistant' && m.usage?.output === 18))

  const runEnd = events.find((e) => e.type === 'run_end') as { status?: string } | undefined
  check('run_end 状态正常', runEnd?.status === 'done', String(runEnd?.status))

  console.log('\n[2] 路径守卫')
  const escape = await executeTool(
    'read',
    { path: '../outside.txt' },
    { workspace, shell: 'auto', signal: new AbortController().signal, log: () => {} }
  )
  check('拒绝越界读取', escape.isError && escape.content.includes('超出工作目录'), escape.content.slice(0, 80))

  const missing = await executeTool(
    'read',
    { path: 'nope.txt' },
    { workspace, shell: 'auto', signal: new AbortController().signal, log: () => {} }
  )
  check('缺失文件返回可读错误', missing.isError && missing.content.includes('不存在'))

  writeFileSync(join(workspace, '..notes'), '合法文件名')
  const dotted = await executeTool(
    'read',
    { path: '..notes' },
    { workspace, shell: 'auto', signal: new AbortController().signal, log: () => {} }
  )
  check('不误拒双点开头的合法文件名', !dotted.isError && dotted.content.includes('合法文件名'))

  writeFileSync(join(workspace, 'paged.txt'), Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join('\n'))
  const paged = await executeTool(
    'read',
    { path: 'paged.txt', offset: 3, limit: 4 },
    { workspace, shell: 'auto', signal: new AbortController().signal, log: () => {} }
  )
  check(
    'read 按行截取并报告截断',
    !paged.isError && paged.content.includes('line-3') && paged.content.includes('line-6') && !paged.content.includes('line-7') && paged.meta?.kind === 'read' && paged.meta.truncated
  )

  const bigLine = 'x'.repeat(4096)
  writeFileSync(join(workspace, 'over-8mb.txt'), Array.from({ length: 2200 }, () => bigLine).join('\n'))
  const largeRead = await executeTool(
    'read',
    { path: 'over-8mb.txt', limit: 2 },
    { workspace, shell: 'auto', signal: new AbortController().signal, log: () => {} }
  )
  check(
    '超过 8MB 的文本可按行读取',
    !largeRead.isError && largeRead.meta?.kind === 'read' && largeRead.meta.totalLines === 2200 && largeRead.content.length < 10000
  )

  let badSessionRejected = false
  try {
    assertSessionId('../outside')
  } catch {
    badSessionRejected = true
  }
  check('会话 ID 拒绝路径穿越', badSessionRejected)

  console.log('\n[3] 会话树分支')
  const assistantId = view.messages.find((m) => m.role === 'assistant')!.id
  sessions.fork(meta.id, assistantId)
  const branchMsg = {
    role: 'user' as const,
    id: 'u_branch_test',
    ts: Date.now(),
    text: '换一条路走'
  }
  sessions.append(meta.id, branchMsg)
  const branched = sessions.view(meta.id)
  const info = branched.branch[branchMsg.id]
  check('产生兄弟分支', Boolean(info) && info.count === 2, JSON.stringify(info))
  // 路径应为：首条 user → 被分叉的 assistant → 新分支上的 user
  check('分叉后路径缩短', branched.messages.length === 3, `${branched.messages.length}`)
  check('新消息接在被分叉的消息之后', branched.messages[2]?.id === branchMsg.id)

  sessions.setLeaf(meta.id, assistantId)
  const back = sessions.view(meta.id)
  check('可回到原分支', back.messages.length === 2, `${back.messages.length}`)

  console.log('\n[4] 配置与日志')
  const pub = config.toPublic()
  const activeProfile = pub.profiles.find((p) => p.id === pub.activeProfileId)
  check('配置不回传明文 key', JSON.stringify(pub).includes('smoke-test-key') === false)
  check('key 状态正确', Boolean(activeProfile?.hasKey))

  let authThrown = false
  try {
    createProvider('openai', 'https://api.example.com/v1', '')
  } catch (err) {
    authThrown = (err as Error).message.includes('API Key')
  }
  check('缺少 key 给出明确错误', authThrown)
  check('本地服务允许空 key', Boolean(createProvider('openai', mock.url, '')))
  const temperatureBefore = config.load().temperature
  let nanRejected = false
  try {
    config.patch({ temperature: Number.NaN })
  } catch {
    nanRejected = true
  }
  check('配置拒绝非有限数值', nanRejected && config.load().temperature === temperatureBefore)

  console.log('\n[5] 提供商识别 + 模型列表')
  const models = await listModels('openai', mock.url, 'smoke-key')
  check('读到模型并排序', models.length === 3 && models[0].id === 'glm-5.3-flash', JSON.stringify(models.map((m) => m.id)))
  const large = models.find((m) => m.id === 'mock-large')
  check('保留 owned_by 信息', large?.hint === 'smoke')
  check(
    '解析接口返回的模型参数',
    large?.contextWindow === 200000 && large?.maxOutput === 64000 && large?.inputs?.join('+') === 'text+image',
    JSON.stringify(large)
  )
  check('接口没给时用内置表兜底', models.find((m) => m.id === 'glm-5.3-flash')?.maxOutput === 131072, JSON.stringify(models.find((m) => m.id === 'glm-5.3-flash')))

  check('识别 deepseek', detectPreset('https://api.deepseek.com/v1')?.id === 'deepseek')
  check('识别 kimi 开放平台', detectPreset('https://api.moonshot.cn/v1')?.id === 'kimi')
  check('按路径识别 kimi-coding', detectPreset('https://api.kimi.com/coding/')?.id === 'kimi-coding')
  check('按路径识别 zai-coding', detectPreset('https://api.z.ai/api/anthropic')?.id === 'zai-coding')
  check('同域不同路径区分 zai', detectPreset('https://api.z.ai/api/paas/v4')?.id === 'zai')
  check('coding 端点默认 Anthropic 协议', inferProtocol('https://api.kimi.com/coding/') === 'anthropic')
  check('/anthropic 路径覆盖默认协议', inferProtocol('https://api.deepseek.com/anthropic') === 'anthropic')
  check('本地地址可免 Key', isLocalHost('http://localhost:11434/v1'))
  check('未知地址推断 OpenAI 兼容', inferProtocol('https://llm.internal.example.com/v1') === 'openai')

  const emptyList = await listModels('openai', `${mock.url}/nope`, 'k').then(
    () => 'unexpected',
    (err: Error) => err.message
  )
  check('模型接口 404 时提示可手动输入', /404|未提供/.test(String(emptyList)), String(emptyList).slice(0, 80))

  console.log('\n[6] 旧配置迁移')
  const legacyFile = join(home, 'legacy-config.json')
  writeFileSync(
    legacyFile,
    JSON.stringify({
      version: 1,
      workspace,
      provider: 'anthropic',
      model: 'claude-legacy',
      temperature: 0.3,
      maxSteps: 20,
      shell: 'auto',
      providers: {
        openai: { baseUrl: 'https://api.openai.com/v1' },
        anthropic: { baseUrl: 'https://api.anthropic.com', apiKey: 'enc:legacy', keyProtected: true }
      }
    })
  )
  const migrated = new ConfigStore(fallbackSecretBox, legacyFile).load()
  check('迁移为档案结构', migrated.version === 2 && migrated.profiles.length === 1, `${migrated.profiles.length}`)
  check('保留原 key 与模型', migrated.profiles[0]?.apiKey === 'enc:legacy' && migrated.model === 'claude-legacy')
  check('切换为原 active 档案', migrated.activeProfileId === 'anthropic', migrated.activeProfileId)

  console.log('\n[7] 会话级模型选择 + 会话级工作目录')
  seenModels.length = 0
  const dirA = join(home, 'proj-a')
  const dirB = join(home, 'proj-b')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })

  const sessionA = sessions.create(dirA, { profileId: 'deepseek', model: 'model-a' })
  const sessionB = sessions.create(dirB, { profileId: 'deepseek', model: 'model-b' })
  await runOnce(sessionA.id, '跑一下 echo a')
  await runOnce(sessionB.id, '跑一下 echo b')
  check('会话 A 用自己的模型', seenModels[0] === 'model-a', seenModels.join(','))
  check('会话 B 用自己的模型', seenModels[seenModels.length - 1] === 'model-b', seenModels.join(','))
  check(
    '两个会话的文件落在各自目录',
    existsSync(join(dirA, 'demo', 'hello.txt')) && existsSync(join(dirB, 'demo', 'hello.txt'))
  )
  check('工作目录写入会话 meta', sessions.meta(sessionA.id).cwd === dirA && sessions.meta(sessionB.id).cwd === dirB)
  sessions.setCwd(sessionA.id, dirB)
  check('可更换会话目录', sessions.view(sessionA.id).cwd === dirB)
  sessions.setCwd(sessionA.id, dirA)
  check(
    '模型写入会话 meta',
    sessions.meta(sessionA.id).model === 'model-a' && sessions.meta(sessionB.id).model === 'model-b'
  )

  sessions.setModel(sessionA.id, 'deepseek', 'model-c')
  check('可在线改绑并持久化', sessions.meta(sessionA.id).model === 'model-c' && sessions.view(sessionA.id).model === 'model-c')

  console.log('\n[8] 惰性项目目录')
  const lazy = sessions.create('', { profileId: 'deepseek', model: 'model-a' })
  check('创建时可以不指定目录', sessions.meta(lazy.id).cwd === '')
  check('未开始时目录可改', sessions.hasStarted(lazy.id) === false)
  await runOnce(lazy.id, '随便跑一下')
  const autoCwd = sessions.meta(lazy.id).cwd
  check('首轮自动创建目录', Boolean(autoCwd) && autoCwd.startsWith(paths.projects()), autoCwd)
  check('目录真实存在', Boolean(autoCwd) && existsSync(autoCwd))
  check('工具落在自动目录里', Boolean(autoCwd) && existsSync(join(autoCwd, 'demo', 'hello.txt')))
  check(
    '通知前端更新目录',
    events.some((e) => e.type === 'session_cwd')
  )
  check('开始后目录锁定', sessions.hasStarted(lazy.id) === true)

  console.log('\n[9] 插件')
  const pluginDir = join(paths.plugins(), 'echo-tool')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ name: 'echo-tool', version: '0.1.0', description: '测试插件', main: 'index.js' })
  )
  writeFileSync(
    join(pluginDir, 'index.js'),
    `module.exports = {
  instructions: '测试插件说明',
  tools: [{
    name: 'echo_text',
    description: '回显文本',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    async run(input) { return { content: 'echo:' + input.text } }
  }]
}
`
  )

  pluginHost.reload()
  const listed = pluginHost.list()
  check('插件被识别', listed.some((p) => p.id === 'echo-tool' && p.tools.includes('echo_text')), JSON.stringify(listed.map((p) => p.id)))
  check('插件工具进入规格表', toolsSpecs().some((s) => s.name === 'echo_text'))
  check('插件提示词已注入', pluginHost.instructions().includes('测试插件说明'))

  const echoed = await executeTool(
    'echo_text',
    { text: 'hi' },
    { workspace: dirA, shell: 'auto', signal: new AbortController().signal, log: () => {} }
  )
  check('插件工具可执行', echoed.content === 'echo:hi', echoed.content)

  pluginHost.setEnabled('echo-tool', false)
  check('停用后工具下线', !toolsSpecs().some((s) => s.name === 'echo_text'))
  pluginHost.setEnabled('echo-tool', true)

  console.log('\n[10] GitHub 安装链路')
  // 手工造一个 store 模式的 zip，模拟 GitHub 归档（顶层 <repo>-<ref>/）
  const zip = makeZip([
    { name: 'demo-repo-main/plugin.json', content: JSON.stringify({ name: 'gh-plugin', version: '1.0.0', main: 'index.js' }) },
    {
      name: 'demo-repo-main/index.js',
      content: `module.exports = { tools: [{ name: 'gh_tool', description: 'x', parameters: { type: 'object' }, async run() { return { content: 'ok' } } }] }`
    }
  ])
  const entries = await unzip(zip)
  check('解包得到全部文件', entries.length === 2, entries.map((e) => e.name).join(','))
  check(
    '文件内容正确',
    entries.find((e) => e.name.endsWith('plugin.json'))?.data.toString('utf8').includes('gh-plugin') === true
  )
  const tooManyEntries = await unzip(
    makeZip(Array.from({ length: 2001 }, (_, i) => ({ name: `repo/file-${i}.txt`, content: '' })))
  ).then(
    () => false,
    () => true
  )
  check('ZIP 拒绝过多条目', tooManyEntries)
  const oversizedZip = makeZip([{ name: 'big.txt', content: 'x' }])
  const centralOffset = oversizedZip.length - 22 - 46 - Buffer.byteLength('big.txt')
  oversizedZip.writeUInt32LE(20 * 1024 * 1024 + 1, centralOffset + 24)
  const oversizedRejected = await unzip(oversizedZip).then(
    () => false,
    () => true
  )
  check('ZIP 拒绝超限解压大小', oversizedRejected)

  check('解析仓库根地址', parseGitHubUrl('https://github.com/acme/demo').repo === 'demo')
  const treeTarget = parseGitHubUrl('https://github.com/acme/demo/tree/dev/packages/plug')
  check('解析分支与子目录', treeTarget.ref === 'dev' && treeTarget.subpath === 'packages/plug', JSON.stringify(treeTarget))
  let rejected = false
  try {
    parseGitHubUrl('https://gitlab.com/acme/demo')
  } catch {
    rejected = true
  }
  check('拒绝非 GitHub 地址', rejected)

  // 走一遍真正的 install 拷贝流程（模拟解包后的目录）
  const ghSrc = join(home, 'gh-src', 'gh-plugin')
  mkdirSync(ghSrc, { recursive: true })
  writeFileSync(join(ghSrc, 'plugin.json'), JSON.stringify({ name: 'gh-plugin', version: '1.0.0', description: '来自仓库', main: 'index.js' }))
  writeFileSync(
    join(ghSrc, 'index.js'),
    `module.exports = { tools: [{ name: 'gh_tool', description: 'x', parameters: { type: 'object' }, async run() { return { content: 'ok' } } }] }`
  )
  const installed = pluginHost.install(ghSrc)
  check('从目录安装成功', installed.id === 'gh-plugin' && installed.tools.includes('gh_tool'), installed.id)
  check('安装后进入工具表', toolsSpecs().some((s) => s.name === 'gh_tool'))

  const onlineZip = makeZip([
    { name: 'online-main/plugin.json', content: JSON.stringify({ name: 'online-plugin', version: '1.0.0', main: 'index.js' }) },
    {
      name: 'online-main/index.js',
      content: `module.exports = { tools: [{ name: 'online_tool', description: 'x', parameters: { type: 'object' }, async run() { return { content: 'online' } } }] }`
    }
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 })
    }
    if (url.startsWith('https://codeload.github.com/')) return new Response(onlineZip, { status: 200 })
    throw new Error(`未预期的测试请求：${url}`)
  }
  try {
    const online = await pluginHost.installFromGitHub('https://github.com/acme/online')
    check('GitHub 在线安装等待完整落盘', online.name === 'online-plugin' && online.tools.includes('online_tool'))
    check('在线插件立即可执行', toolsSpecs().some((s) => s.name === 'online_tool'))
  } finally {
    globalThis.fetch = originalFetch
  }

  console.log('\n[11] 流式鲁棒性')
  const { sseData, safeJsonParse, request } = await import('../src/main/agent/providers/sse')

  // 只返回思维链的模型，错误提示要能说明原因，而不是笼统的"空内容"
  const reasoningProvider = createProvider('openai', mock.url, 'smoke-key')
  let reasoningErr = ''
  try {
    await reasoningProvider.stream({
      system: 'x',
      messages: [{ role: 'user', id: 'u1', ts: Date.now(), text: 'hi' }],
      tools: [],
      model: 'mock-reasoning-only',
      temperature: 0,
      thinking: 'high',
      signal: new AbortController().signal,
      onTextDelta: () => {}
    })
  } catch (err) {
    reasoningErr = (err as Error).message
  }
  check('只返回思维链时提示可读', reasoningErr.includes('思维链'), reasoningErr)

  // 连接不断但一直没数据：必须超时，不能无限等
  const stalled = new Response(
    new ReadableStream({
      start() {
        /* 永不入队，也不关闭 */
      }
    })
  )
  const startedAt = Date.now()
  let stallErr = ''
  try {
    for await (const chunk of sseData(stalled, { idleMs: 80 })) {
      void chunk
    }
  } catch (err) {
    stallErr = (err as Error).message
  }
  const waited = Date.now() - startedAt
  check('卡住的流会主动超时', stallErr.includes('超时') && waited < 3000, `${waited}ms · ${stallErr}`)

  let malformedArgsRejected = false
  try {
    safeJsonParse('{broken')
  } catch (err) {
    malformedArgsRejected = (err as Error).message.includes('无法解析')
  }
  check('破损工具参数不会继续执行', malformedArgsRejected)
  let arrayArgsRejected = false
  try {
    safeJsonParse('[]')
  } catch {
    arrayArgsRejected = true
  }
  check('工具参数必须是对象', arrayArgsRejected)

  const headerServer = createServer(() => {
    /* 故意永不返回响应头 */
  })
  await new Promise<void>((resolve) => headerServer.listen(0, '127.0.0.1', resolve))
  const headerAddress = headerServer.address()
  const headerUrl = `http://127.0.0.1:${typeof headerAddress === 'object' && headerAddress ? headerAddress.port : 0}`
  const headerStarted = Date.now()
  let headerTimeout = ''
  try {
    await request(headerUrl, {}, 40)
  } catch (err) {
    headerTimeout = (err as Error).message
  }
  check('响应头等待有完整超时', headerTimeout.includes('响应头超时') && Date.now() - headerStarted < 3000, headerTimeout)
  await new Promise<void>((resolve) => headerServer.close(() => resolve()))

  console.log('\n[11b] 网络错误分类与退避重试')
  const { streamWithRetry } = await import('../src/main/agent/providers')
  const { networkFailure, parseRetryAfterMs, AgentFailure } = await import('../src/main/agent/errors')

  // 1) "fetch failed" 必须被拆成能照做的一句话（host + 错误码 + 耗时）
  const refused = networkFailure(
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    }),
    'https://api.z.ai/api/anthropic/v1/messages',
    42
  )
  check(
    '连接被拒绝：带出 host / 错误码 / 耗时',
    refused.message.includes('api.z.ai') && refused.message.includes('ECONNREFUSED') && refused.message.includes('0.0s'),
    refused.message
  )
  check('连接被拒绝归类为可重试', refused.retryable && refused.code === 'refused', `${refused.code} retryable=${refused.retryable}`)

  // 2) Node 20+ 的 autoSelectFamily 会把多地址失败包成 AggregateError，也要能拆
  const aggregated = networkFailure(
    Object.assign(new TypeError('fetch failed'), {
      cause: new AggregateError(
        [Object.assign(new Error('connect ETIMEDOUT 1.2.3.4:443'), { code: 'ETIMEDOUT' })],
        'connect ETIMEDOUT'
      )
    }),
    'https://example.com/v1',
    1200
  )
  check('多地址聚合错误识别为超时', aggregated.code === 'timeout' && aggregated.message.includes('ETIMEDOUT'), aggregated.message)

  // 3) 证书错误重试只会在同一堵墙上撞 5 次，必须立刻放弃
  const tls = networkFailure(
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    }),
    'https://proxy.corp/v1',
    10
  )
  check('证书错误不重试', tls.code === 'tls' && tls.retryable === false, `${tls.code} retryable=${tls.retryable}`)

  // 4) Retry-After 两种写法
  check('Retry-After 秒数可解析', parseRetryAfterMs('3') === 3000, String(parseRetryAfterMs('3')))
  check('Retry-After 非法值忽略', parseRetryAfterMs('soon') === undefined)
  check('Retry-After 也认 HTTP 日期', typeof parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString()) === 'number')

  // 4b) HTTP 规范禁用的保留端口：请求根本没发出去，不该当网络抖动重试 5 次
  const badPort = networkFailure(
    Object.assign(new TypeError('fetch failed'), { cause: new Error('bad port') }),
    'http://127.0.0.1:1/v1/chat/completions',
    1
  )
  check('保留端口不重试且说明原因', badPort.code === 'bad_port' && badPort.retryable === false, badPort.message)

  // 5) 端到端：前两次连接被掐断，第三次成功；用户侧必须看到每次重试
  const flakySession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-flaky' })
  const flakyEvents: AgentEvent[] = []
  const flakyRunner = new AgentRunner(sessions, config, logger, (e) => flakyEvents.push(e))
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (flakyEvents.some((e) => e.type === 'run_end')) {
        clearInterval(timer)
        resolve()
      }
    }, 20)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 30_000)
    flakyRunner.send(flakySession.id, '网络抖一下再回答')
  })
  const flakyEnd = flakyEvents.find((e): e is Extract<AgentEvent, { type: 'run_end' }> => e.type === 'run_end')
  const retryNotices = flakyEvents.filter(
    (e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice' && e.text.includes('秒后重试')
  )
  check('连接被掐断后自动重试到成功', flakyEnd?.status === 'done', JSON.stringify(flakyEnd))
  check(
    '每次重试都提示用户（1/5、2/5）',
    retryNotices.length === 2 && retryNotices[0].text.includes('1/5') && retryNotices[1].text.includes('2/5'),
    JSON.stringify(retryNotices.map((n) => n.text))
  )
  const flakyAssistant = sessions
    .view(flakySession.id)
    .messages.filter((m): m is AssistantMessage => m.role === 'assistant')
  check('重试后拿到正常回复（没有留下 error 消息）', flakyAssistant.length > 0 && !flakyAssistant.some((m) => m.error), JSON.stringify(flakyAssistant.map((m) => m.stopReason)))

  // 6) 连不上时：报错可读，且重试用尽后及时返回（不会无限转圈）。
  //    先绑再关拿一个"确定没人在听"的高位端口——1/9 这类保留端口会被 undici 在发请求前拒掉，
  //    走不到 TCP 层，验证不到真实的 ECONNREFUSED 路径。
  const probe = createServer(() => {})
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const probeAddr = probe.address()
  const closedPort = typeof probeAddr === 'object' && probeAddr ? probeAddr.port : 0
  await new Promise<void>((r) => probe.close(() => r()))
  const refusedStarted = Date.now()
  let refusedMsg = ''
  try {
    await streamWithRetry(
      createProvider('openai', `http://127.0.0.1:${closedPort}`, 'smoke-key'),
      {
        system: 'x',
        messages: [{ role: 'user', id: 'u9', ts: Date.now(), text: 'hi' }],
        tools: [],
        model: 'm',
        temperature: 0,
        thinking: 'low',
        signal: new AbortController().signal,
        onTextDelta: () => {}
      },
      () => {},
      { maxAttempts: 2 }
    )
  } catch (err) {
    refusedMsg = (err as Error).message
    check('失败仍是 AgentFailure（可分类）', err instanceof AgentFailure)
  }
  check(
    '连不上时给出可操作的报错',
    refusedMsg.includes('127.0.0.1') && /拒绝|超时|ECONNREFUSED|EACCES/.test(refusedMsg),
    refusedMsg
  )
  check('重试用尽后立即返回', Date.now() - refusedStarted < 8000, `${Date.now() - refusedStarted}ms`)

  console.log('\n[11c] 重试上一步')
  {
    const retryDir = join(workspace, 'retry-proj')
    mkdirSync(retryDir, { recursive: true })

    // 1) 没有失败回复时拒绝：重试不是"再问一遍"，不该被当成普通发送
    const healthy = sessions.create(retryDir, { profileId: 'deepseek', model: 'mock-small' }).id
    sessions.append(healthy, { role: 'user', id: 'h1', ts: Date.now() - 1000, text: '正常的一步' })
    sessions.append(healthy, {
      role: 'assistant', id: 'h2', ts: Date.now(), model: 'mock-small', provider: 'openai',
      stopReason: 'stop', blocks: [{ type: 'text', text: '正常回复' }]
    })
    const probeRunner = new AgentRunner(sessions, config, logger, () => {})
    let refusedRetry = ''
    try {
      probeRunner.retry(healthy)
    } catch (err) {
      refusedRetry = (err as Error).message
    }
    check('最后一步没失败时拒绝重试', refusedRetry.includes('不是失败状态'), refusedRetry)

    // 2) 失败回复 → 回退一格重新生成
    const sid = sessions.create(retryDir, { profileId: 'deepseek', model: 'mock-small' }).id
    const now = Date.now()
    sessions.append(sid, { role: 'user', id: 'rt-u1', ts: now - 1000, text: 'RETRY-TEST 重试这一步' })
    sessions.append(sid, {
      role: 'assistant', id: 'rt-a1', ts: now, model: 'mock-small', provider: 'openai',
      stopReason: 'error', error: '请求失败：fetch failed', blocks: []
    })
    const before = sessions.view(sid).messages
    check('重试前叶子是失败回复', before.length === 2 && before[1].id === 'rt-a1', JSON.stringify(before.map((m) => m.id)))

    const retryEvents: AgentEvent[] = []
    const retryRunner = new AgentRunner(sessions, config, logger, (e) => retryEvents.push(e))
    retryRunner.retry(sid)
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (retryEvents.some((e) => e.type === 'run_end')) {
          clearInterval(timer)
          resolve()
        }
      }, 20)
      setTimeout(() => {
        clearInterval(timer)
        resolve()
      }, 30_000)
    })

    const after = sessions.view(sid)
    const tail = after.messages[after.messages.length - 1]
    check('重试后叶子变成新的正常回复', tail?.role === 'assistant' && tail.stopReason !== 'error', JSON.stringify(tail))
    check('没有新增 user 消息', after.messages.filter((m) => m.role === 'user').length === 1, `${after.messages.length} 条`)
    check('失败的那次仍在会话树里（可切回）', sessions.entries(sid).some((e) => e.id === 'rt-a1'))
    // 兄弟关系看树本身，不看分支路径：重试可能产生 tool 往返，末条不一定是直接兄弟
    const siblingsOfFirst = sessions.entries(sid).filter((e) => e.parentId === 'rt-u1')
    check(
      '失败的那次与新回复成为兄弟',
      siblingsOfFirst.length === 2 && siblingsOfFirst.some((e) => e.id === 'rt-a1'),
      JSON.stringify(siblingsOfFirst.map((e) => `${e.id}:${e.message.role}`))
    )
  }

  console.log('\n[12] 思考强度')
  const baseReq = (model: string, thinking: 'low' | 'high' | 'max') => ({
    system: 'x',
    messages: [{ role: 'user' as const, id: 'u1', ts: Date.now(), text: 'hi' }],
    tools: [],
    model,
    temperature: 0,
    thinking,
    signal: new AbortController().signal,
    onTextDelta: () => {}
  })

  seenEffort.length = 0
  await createProvider('openai', mock.url, 'smoke-key').stream(baseReq('glm-5.3-flash', 'max'))
  check('推理模型会带上 reasoning_effort', seenEffort[0] === 'max', String(seenEffort[0]))

  seenEffort.length = 0
  await createProvider('openai', mock.url, 'smoke-key').stream(baseReq('mock-thinking-reject', 'low'))
  check(
    '服务端不认参数时自动降级重试',
    seenEffort.length === 2 && seenEffort[0] === 'low' && seenEffort[1] === undefined,
    JSON.stringify(seenEffort)
  )

  console.log('\n[13] 会话级思考强度')
  const st = sessions.create(dirA, { profileId: 'deepseek', model: 'model-a' })
  check('默认跟随全局', sessions.view(st.id).thinking === undefined)
  sessions.setThinking(st.id, 'max')
  check('可写入会话 meta', sessions.view(st.id).thinking === 'max')
  sessions.setThinking(st.id, undefined)
  check('可恢复跟随全局', sessions.view(st.id).thinking === undefined)

  console.log('\n[14] 输出上限与降档重试')

  seenMaxTokens.length = 0
  await createProvider('openai', mock.url, 'smoke-key').stream({
    ...baseReq('glm-5.3-flash', 'high'),
    maxTokens: 20000
  })
  check('请求带上 max_tokens', seenMaxTokens[0] === 20000, String(seenMaxTokens[0]))

  seenMaxTokens.length = 0
  seenCompletionTokens.length = 0
  seenTemperature.length = 0
  await createProvider('openai', mock.url, 'smoke-key').stream({
    ...baseReq('gpt-5.2', 'high'),
    maxTokens: 12345
  })
  check(
    'GPT-5 使用 max_completion_tokens 且省略 temperature',
    seenCompletionTokens[0] === 12345 && seenMaxTokens[0] === undefined && seenTemperature[0] === undefined,
    JSON.stringify({ completion: seenCompletionTokens[0], max: seenMaxTokens[0], temperature: seenTemperature[0] })
  )

  const budget = sessions.create(workspace, { profileId: 'deepseek', model: 'glm-5.3-budget-eaten' })
  sessions.setThinking(budget.id, 'max')
  const effortBefore = seenEffort.length
  await runOnce(budget.id, '写点东西')

  const budgetLast = sessions
    .view(budget.id)
    .messages.filter((m) => m.role === 'assistant')
    .pop()
  const lastMsg = budgetLast && budgetLast.role === 'assistant' ? budgetLast : null
  check(
    '思考吃光额度时自动降档重试',
    Boolean(lastMsg && !lastMsg.error && lastMsg.blocks.length > 0),
    lastMsg ? (lastMsg.error ?? `blocks=${lastMsg.blocks.length}`) : '没有 assistant 消息'
  )
  check(
    '两次请求：先 max 再 low',
    seenEffort.slice(effortBefore).join(',') === 'max,low',
    seenEffort.slice(effortBefore).join(',')
  )

  // 会话级覆盖必须真的进入请求：从会话 meta 一路走到 HTTP body
  const thinkSession = sessions.create(workspace, { profileId: 'deepseek', model: 'glm-5.3-flash' })
  sessions.setThinking(thinkSession.id, 'max')
  seenEffort.length = 0
  await runOnce(thinkSession.id, '跑一下')
  check('会话级思考强度进入请求', seenEffort[0] === 'max', seenEffort.join(','))

  console.log('\n[13b] 不设步数上限')
  const longSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-longrun' })
  const longEvents: AgentEvent[] = []
  const longRunner = new AgentRunner(sessions, config, logger, (e) => longEvents.push(e))
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (longEvents.some((e) => e.type === 'run_end')) {
        clearInterval(timer)
        resolve()
      }
    }, 20)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 120_000)
    longRunner.send(longSession.id, '一直做到你自己停')
  })

  const longSteps = sessions.view(longSession.id).messages.filter((m) => m.role === 'assistant').length
  check('45 轮工具往返不被截断（旧版 40 步就停）', longSteps === 46, `assistant=${longSteps}`)
  const capNoise = longEvents.filter(
    (e) => e.type === 'notice' && (e.text.includes('步数') || e.text.includes('步上限'))
  )
  check('不再出现步数相关的停止提示', capNoise.length === 0, JSON.stringify(capNoise))
  const longEnd = longEvents.find((e) => e.type === 'run_end')
  check('跑到模型自己收尾才结束', longEnd?.type === 'run_end' && longEnd.status === 'done', JSON.stringify(longEnd))
  console.log('\n[13d] 空转检测（纯函数，只提醒不中止）')
  const { assess, callKey, canonicalInput, resultDigest, stabilizeResult, DEFAULTS } = await import(
    '../src/main/agent/stuck-guard'
  )
  const ok = (content: string): string => resultDigest(content, false)
  const bad = (content: string): string => resultDigest(content, true)

  // 参数指纹：键序无关，工具名参与
  check(
    '参数键序不同视为同一次调用',
    callKey('read', { path: 'a.txt', limit: 10 }) === callKey('read', { limit: 10, path: 'a.txt' }),
    canonicalInput({ path: 'a.txt', limit: 10 })
  )
  check('参数不同则是不同调用', callKey('read', { path: 'a.txt' }) !== callKey('read', { path: 'b.txt' }))
  check('工具不同则是不同调用', callKey('read', { path: 'a.txt' }) !== callKey('write', { path: 'a.txt' }))

  // 结果指纹：bash footer 里的耗时必须被抹掉，否则同命令同输出永远判成"结果不同"
  const bashA = resultDigest(`${"x".repeat(20)}\n\n[exit 0 · 0.3s]`, false)
  const bashB = resultDigest(`${"x".repeat(20)}\n\n[exit 0 · 1.9s]`, false)
  check('footer 里的耗时不影响结果指纹', bashA === bashB, `${bashA} vs ${bashB}`)
  check('超时标记会被保留', stabilizeResult('out\n\n[exit killed · 超时 120s 已终止 · 120.0s]').includes('超时'))
  check('isError 参与指纹', ok('same') !== bad('same'))

  // 模式 1：同参数同结果 —— 到阈值提醒（阈值 4，对齐 OpenHands 的 action+observation）
  const key = callKey('read', { path: 'a.txt' })
  const same = (n: number) => Array.from({ length: n }, () => ({ key, digest: ok("hello"), isError: false }))
  check('3 次：还没到阈值，不提醒', assess(same(3)).hint === undefined)
  check('4 次：提醒', Boolean(assess(same(4)).hint) && assess(same(4)).kind === 'identical')
  check('5/6/7 次：不重复刷屏', assess(same(5)).hint === undefined && assess(same(7)).hint === undefined)
  check('8 次：再提醒一次', Boolean(assess(same(8)).hint), String(assess(same(8)).count))
  check(
    '阈值来自 DEFAULTS.nudgeIdentical',
    DEFAULTS.nudgeIdentical === 4 && assess(same(4)).hint !== undefined
  )

  // 关键：同参数但结果在变 = 有进展，绝不提醒
  const progressing = [
    { key, digest: ok("v1"), isError: false },
    { key, digest: ok("v2"), isError: false },
    { key, digest: ok("v3"), isError: false },
    { key, digest: ok("v4"), isError: false }
  ]
  check('同参数但结果在变：不提醒', assess(progressing).hint === undefined)

  // 模式 2：连续失败（不看参数是否相同）—— Cline 的维度
  const failing = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      key: callKey('bash', { command: `attempt-${i}` }),
      digest: bad(`error ${i}`),
      isError: true
    }))
  check('连续 2 次失败：不提醒', assess(failing(2)).hint === undefined)
  check('连续 3 次失败：提醒', Boolean(assess(failing(3)).hint) && assess(failing(3)).kind === 'failing')
  check('连续 4 次失败：不重复刷屏', assess(failing(4)).hint === undefined)
  check('连续 6 次失败：再提醒', Boolean(assess(failing(6)).hint))

  // 模式 3：A→B→A→B 交替循环（阈值 6，对齐 OpenHands 的 alternating_pattern）
  const ka = callKey("bash", { command: "npm run build" })
  const kb = callKey("read", { path: "log.txt" })
  const alternate = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      i % 2 === 0
        ? { key: ka, digest: ok("build failed"), isError: false }
        : { key: kb, digest: ok("same log"), isError: false }
    )
  check('4 步交替：不提醒', assess(alternate(4)).hint === undefined)
  check('6 步交替：提醒', Boolean(assess(alternate(6)).hint) && assess(alternate(6)).kind === 'alternating')

  // A == B 时不算交替：那是「一个动作原地重复」，归 identical 管。
  // （曾经漏了这个判断，连续 10 次同一个调用会在第 6 次误报「两个动作反复交替」。）
  check('同一个调用重复 6 次不会被说成交替', assess(same(6)).hint === undefined, JSON.stringify(assess(same(6))))
  check('同一个调用重复 8 次报的是 identical', assess(same(8)).kind === 'identical')

  check('提醒里有工具名与次数', Boolean(assess(same(4)).hint?.includes('read') && assess(same(4)).hint?.includes('4')))
  check('提醒明确写了不中断', Boolean(assess(same(4)).hint?.includes('不中断')))

  console.log('\n[13e] 空转检测（端到端，不中止）')
  // mock-stuck 每轮都发完全相同的 read，结果恒定；靠模型自己收尾，runner 不得中止
  const stuckSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-stuck' })
  const stuckEvents: AgentEvent[] = []
  const stuckRunner = new AgentRunner(sessions, config, logger, (e) => stuckEvents.push(e))
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (stuckEvents.some((e) => e.type === 'run_end')) {
        clearInterval(timer)
        resolve()
      }
    }, 20)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 60_000)
    stuckRunner.send(stuckSession.id, '反复读同一个文件')
  })

  const stuckTools = sessions
    .view(stuckSession.id)
    .messages.filter((m): m is ToolMessage => m.role === 'tool' && m.name === 'read')
  check('没被中止：跑到模型自己收尾（mock 共 10 轮）', stuckTools.length === 10, `实际 ${stuckTools.length} 次`)
  check('第 4 次进了提醒', stuckTools[3]?.content.includes('重复调用提醒') === true)
  check('第 8 次再提醒一次', stuckTools[7]?.content.includes('重复调用提醒') === true)
  check('前 3 次没有噪音', !stuckTools[0]?.content.includes('提醒') && !stuckTools[2]?.content.includes('提醒'))
  check('第 5/6/7 次也不刷屏', !stuckTools[4]?.content.includes('重复调用提醒') && !stuckTools[6]?.content.includes('重复调用提醒'))

  const stuckEnd = stuckEvents.find((e) => e.type === 'run_end')
  check('结束状态是 done（空转不中止）', stuckEnd?.type === 'run_end' && stuckEnd.status === 'done', JSON.stringify(stuckEnd))

  const stuckNotices = stuckEvents.filter(
    (e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice' && e.text.includes('已提示模型换思路')
  )
  check('用户侧收到两条提醒', stuckNotices.length === 2, JSON.stringify(stuckNotices.map((n) => n.text)))
  check('提醒级别统一是 warn', stuckNotices.every((n) => n.level === 'warn'))
  check('没有 error 级 notice', !stuckEvents.some((e) => e.type === 'notice' && e.level === 'error'))

  console.log('\n[13f] 上下文预算提醒（对齐 Codex RolloutBudget）')
  const { assessBudget, BUDGET_THRESHOLDS } = await import('../src/main/agent/budget-guard')
  const W = 100_000

  check('窗口未知时不做任何判断', assessBudget(90_000, undefined).remind === false)
  check('用量为 0 时不提醒', assessBudget(0, W).remind === false)
  check('还剩 80%：不提醒', assessBudget(20_000, W).remind === false)
  const b50 = assessBudget(50_000, W)
  check('还剩 50%：第 1 档提醒', b50.remind && b50.index === 1, JSON.stringify(b50))
  check('提醒里带剩余百分比', Boolean(b50.hint?.includes('50%')), b50.hint?.slice(0, 60))
  check('同一档不重复提醒', assessBudget(52_000, W, b50.state).remind === false)
  const b75 = assessBudget(75_000, W, b50.state)
  check('还剩 25%：第 2 档提醒', b75.remind && b75.index === 2, JSON.stringify(b75))
  const b90 = assessBudget(90_000, W, b75.state)
  check('还剩 10%：第 3 档提醒', b90.remind && b90.index === 3, JSON.stringify(b90))
  check('最后一档措辞更急', Boolean(b90.hint?.includes('优先收尾')), b90.hint?.slice(0, 80))
  check('三档阈值与状态栏 75/90 对齐', BUDGET_THRESHOLDS.join(',') === '0.5,0.25,0.1', BUDGET_THRESHOLDS.join(','))
  check('已经跨过的档位不会回退', assessBudget(95_000, W, b90.state).state.delivered === 3)

  // 端到端：模型窗口设成 1000，mock 每轮递增 usage，应当逐档提醒
  config.saveModels('deepseek', [{ id: 'mock-budget', contextWindow: 1000, maxOutput: 512 }])
  const budgetSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-budget' })
  const budgetEvents: AgentEvent[] = []
  const budgetRunner = new AgentRunner(sessions, config, logger, (e) => budgetEvents.push(e))
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (budgetEvents.some((e) => e.type === 'run_end')) {
        clearInterval(timer)
        resolve()
      }
    }, 20)
    setTimeout(() => {
      clearInterval(timer)
      resolve()
    }, 60_000)
    budgetRunner.send(budgetSession.id, '跑几步看看预算')
  })

  const budgetTools = sessions
    .view(budgetSession.id)
    .messages.filter((m): m is ToolMessage => m.role === 'tool' && m.name === 'read')
  check('5 次工具调用都执行了', budgetTools.length === 5, `实际 ${budgetTools.length}`)
  const hints = budgetTools.map((m) => (m.content.includes('[上下文预算]') ? 1 : 0))
  check('预算提醒出现在第 3/4/5 次', hints.join(',') === '0,0,1,1,1', hints.join(','))
  check('提醒里有剩余百分比', Boolean(budgetTools[2]?.content.includes('剩余约')), budgetTools[2]?.content.slice(-120))
  check('最后一档措辞更急', Boolean(budgetTools[4]?.content.includes('优先收尾')))

  const budgetNotices = budgetEvents.filter(
    (e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice' && e.text.includes('上下文已用')
  )
  check('用户侧也收到三档提醒', budgetNotices.length === 3, JSON.stringify(budgetNotices.map((n) => n.text)))
  check('用户侧提醒是 info 级', budgetNotices.every((n) => n.level === 'info'))

  const budgetEnd = budgetEvents.find((e) => e.type === 'run_end')
  check('预算提醒不中止运行', budgetEnd?.type === 'run_end' && budgetEnd.status === 'done', JSON.stringify(budgetEnd))

  // 恢复：别让工具元数据影响后续用例
  config.saveModels('deepseek', [])


  console.log('\n[13c] 上下文窗口解析（状态栏百分比）')
  console.log('\n[13c] 上下文窗口解析（状态栏百分比）')
  const { resolveContextWindow } = await import('../src/shared/model-catalog')
  // 复现过的真实事故：接口说 deepseek-flash 是 1M，内置表只有泛化的 128K，
  // 状态栏只查内置表 → 205701 / 128000 = 161% → 封顶成 100%，实际只用两成
  check('接口给的窗口优先于内置表', resolveContextWindow('deepseek-flash', { contextWindow: 1048576 }) === 1048576)
  check('没有接口值才回落内置表', resolveContextWindow('deepseek-flash') === 128000)
  check('内置表没有的模型返回 undefined', resolveContextWindow('no-such-model-xyz', {}) === undefined)
  const pct = Math.round((205701 / (resolveContextWindow('deepseek-flash', { contextWindow: 1048576 }) as number)) * 100)
  check('真实占用算成 20% 而不是 100%', pct === 20, `${pct}%`)

  console.log('\n[21] 附件')
  const { stageAttachment, validAttachmentsFor, removeSessionAttachments, sessionAttachmentsDir, MAX_ATTACHMENTS } =
    await import('../src/main/attachments')

  const tinyPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
  const attSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-plain' })
  const imgAtt = stageAttachment(attSession.id, 'dot.png', 'image/png', new Uint8Array(tinyPng))
  const txtAtt = stageAttachment(attSession.id, 'notes.txt', 'text/plain', new Uint8Array(Buffer.from('附件要点：a=1\n')))
  check('图片附件按 image 暂存', imgAtt.kind === 'image' && imgAtt.size === tinyPng.length)
  check('文本附件按 text 暂存', txtAtt.kind === 'text')

  check(
    '拒绝不支持的类型',
    (() => {
      try {
        stageAttachment(attSession.id, 'blob.bin', 'application/octet-stream', new Uint8Array([1, 2, 3]))
        return false
      } catch (err) {
        return (err as Error).message.includes('暂不支持')
      }
    })()
  )
  check(
    '拒绝超限文本附件',
    (() => {
      try {
        stageAttachment(attSession.id, 'too-big.txt', 'text/plain', new Uint8Array(256 * 1024 + 1))
        return false
      } catch (err) {
        return (err as Error).message.includes('256KB')
      }
    })()
  )
  check(
    '拒绝会话外的附件路径',
    (() => {
      try {
        validAttachmentsFor(attSession.id, [{ ...imgAtt, path: join(home, 'config.json') }])
        return false
      } catch (err) {
        return (err as Error).message.includes('拒绝')
      }
    })()
  )
  check(
    '拒绝超量附件',
    (() => {
      try {
        validAttachmentsFor(attSession.id, Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ ...imgAtt })))
        return false
      } catch (err) {
        return (err as Error).message.includes('最多')
      }
    })()
  )

  const userContentsBefore = seenLastUserContent.length
  await runOnce(attSession.id, '看图和附件', [imgAtt, txtAtt])

  const withImg = seenLastUserContent
    .slice(userContentsBefore)
    .find((c) => c.includes('dot.png') || c.includes('data:image'))
  check(
    '图片附件进入请求（data URL）',
    Boolean(withImg && withImg.includes('data:image/png;base64,') && withImg.includes(tinyPng.toString('base64'))),
    withImg?.slice(0, 120) ?? '未捕获到带附件的请求'
  )
  check('文本附件内联进请求', Boolean(withImg && withImg.includes('附件要点：a=1')), withImg?.slice(0, 120) ?? '')

  const attView = sessions.view(attSession.id)
  const attUser = attView.messages.find((m) => m.role === 'user' && (m as { attachments?: unknown }).attachments)
  check(
    '附件元数据随消息落盘',
    Boolean(attUser && attUser.role === 'user' && attUser.attachments?.length === 2)
  )

  removeSessionAttachments(attSession.id)
  check('会话删除后清理附件目录', !existsSync(sessionAttachmentsDir(attSession.id)))

  console.log('\n[22] 运行轨迹')
  const { buildTrajectory } = await import('../src/main/trajectory')
  const { trajectoryToMarkdown } = await import('../src/main/trajectory-md')
  // meta 会话在 [3] 分叉测试里被切过分支，当前路径不含工具消息；这里跑一个干净会话
  const trajSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-model' })
  await runOnce(trajSession.id, '创建 demo/hello.txt，把 world 改成 pi，再运行 echo')
  const traj = buildTrajectory(sessions, trajSession.id)

  check('轨迹按用户消息分段', traj.turns.length >= 1 && traj.turns[0].userText.includes('创建 demo'), JSON.stringify(traj.turns.map((t) => t.userText)))
  const firstTurn = traj.turns[0]
  check(
    '回合内收集模型响应与工具往返',
    firstTurn.steps >= 2 && firstTurn.responses.some((r) => r.toolCalls.length > 0),
    `steps=${firstTurn.steps} calls=${firstTurn.responses.reduce((n, r) => n + r.toolCalls.length, 0)}`
  )
  check(
    '工具往返带结果与耗时标记',
    firstTurn.responses.some((r) =>
      r.toolCalls.some((c) => c.name === 'bash' && !c.isError && c.durationMs !== undefined)
    ),
    JSON.stringify(firstTurn.responses.flatMap((r) => r.toolCalls.map((c) => ({ n: c.name, err: c.isError, dur: c.durationMs }))))
  )
  check(
    'token 按回合聚合',
    firstTurn.inputTokens > 0 && firstTurn.outputTokens > 0 && traj.totals.inputTokens >= firstTurn.inputTokens,
    `in=${firstTurn.inputTokens} out=${firstTurn.outputTokens}`
  )

  const md = trajectoryToMarkdown(traj)
  check('Markdown 报告含汇总与回合', md.includes('# 运行轨迹') && md.includes('回合 1') && md.includes('bash'), md.slice(0, 120))
  check('Markdown 工具段带命令与观察', md.includes('✓ bash') && md.includes('```'), md.slice(0, 400))

  console.log('\n[23] 子智能体')
  const subSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-model' })
  await runOnce(subSession.id, 'SPAWN-SUBTASK-SMOKE：派生一个子智能体去跑冒烟任务')

  const subView = sessions.view(subSession.id)
  const taskCall = subView.messages.find(
    (m) => m.role === 'assistant' && m.blocks.some((b) => b.type === 'tool_use' && b.name === 'task')
  )
  check('父会话收到 task 工具调用', Boolean(taskCall), subView.messages.map((m) => m.role).join(','))

  const taskResult = subView.messages.find((m) => m.role === 'tool' && m.name === 'task')
  check(
    '子智能体真的执行了工具并汇报',
    Boolean(
      taskResult &&
        taskResult.role === 'tool' &&
        !taskResult.isError &&
        taskResult.content.includes('子任务完成') &&
        taskResult.content.includes('sub-agent-ok')
    ),
    taskResult?.role === 'tool' ? taskResult.content.slice(0, 120) : '无 task 结果'
  )
  check(
    'task 结果带子任务统计',
    taskResult?.role === 'tool' && taskResult.meta?.kind === 'task' && taskResult.meta.steps === 2 && taskResult.meta.inputTokens === 240,
    JSON.stringify(taskResult?.role === 'tool' ? taskResult.meta : undefined)
  )

  // 子智能体的过程不落盘：父会话历史里只有 task 调用与结果，没有子循环的 bash 消息
  const leaked = subView.messages.filter((m) => m.role === 'tool' && m.name === 'bash')
  check('子循环过程不污染父会话', leaked.length === 0, `${leaked.length} 条 bash 消息泄漏`)

  // 轨迹里 task 步骤带上统计
  const subTraj = buildTrajectory(sessions, subSession.id)
  const trajTask = subTraj.turns[0]?.responses.flatMap((r) => r.toolCalls).find((c) => c.name === 'task')
  check(
    '轨迹包含子任务步骤与统计',
    Boolean(trajTask && trajTask.meta?.kind === 'task' && trajTask.meta.outputTokens === 45),
    JSON.stringify(trajTask?.meta)
  )

  // 并行子任务：同一轮两个 task 应该并发跑（mock 的并发峰值 = 2），而不是排队
  mockMaxConcurrent = 0
  const parSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-model' })
  await runOnce(parSession.id, 'PARALLEL-SUBTASKS-SMOKE：同时派生两个子智能体')
  const parResults = sessions
    .view(parSession.id)
    .messages.filter((m): m is ToolMessage => m.role === 'tool' && m.name === 'task')
  // 并行子任务：两个 task 的 tool_start 都应在第一个 tool_end 之前（并行），串行则是 start→end→start→end
  const parFlow = events.filter((e) => {
    if (e.type === 'tool_start') return String((e as { callId?: string }).callId ?? '').startsWith('call_par_')
    if (e.type === 'tool_end') return String((e as { message?: ToolMessage }).message?.toolCallId ?? '').startsWith('call_par_')
    return false
  })
  const startIdx = parFlow.map((e, i) => (e.type === 'tool_start' ? i : -1)).filter((i) => i >= 0)
  const firstEndIdx = parFlow.findIndex((e) => e.type === 'tool_end')
  check('同轮两个 task 并行执行', startIdx.length === 2 && startIdx.every((i) => i < firstEndIdx), parFlow.map((e) => e.type).join(','))
  check(
    '两个子任务都完整落盘',
    parResults.length === 2 && parResults.every((m) => !m.isError && m.meta?.kind === 'task'),
    JSON.stringify(parResults.map((m) => m.meta))
  )

  // 进度事件：子任务执行期间应发出 subagent_tool start/end（不落盘，只喂界面）
  const subEvents = events.filter(
    (e): e is Extract<AgentEvent, { type: 'subagent_tool' }> => e.type === 'subagent_tool'
  )
  check(
    '子任务工具活动有进度事件',
    subEvents.some((e) => e.name === 'bash' && e.phase === 'start') && subEvents.some((e) => e.name === 'bash' && e.phase === 'end'),
    `${subEvents.length} 条`
  )
  check(
    '进度事件不落盘',
    !sessions.view(parSession.id).messages.some((m) => 'subagent_tool' in m),
    ''
  )

  console.log('\n[24] 子类型与记忆')
  const { subagentsFile } = await import('../src/main/agent/session')
  // explore 类型：只读子智能体
  seenSubToolNamesLast = ''
  const expSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-model' })
  await runOnce(expSession.id, 'EXPLORE-SUBTASK-SMOKE：派生只读子智能体调研目录')
  check(
    'explore 子智能体没有写类工具',
    seenSubToolNamesLast.includes('read') &&
      !seenSubToolNamesLast.includes('bash') &&
      !seenSubToolNamesLast.includes('write') &&
      !seenSubToolNamesLast.includes('edit') &&
      !seenSubToolNamesLast.includes('task') &&
      !seenSubToolNamesLast.includes('memory') &&
      !seenSubToolNamesLast.includes('skills'),
    seenSubToolNamesLast
  )
  const expResult = sessions
    .view(expSession.id)
    .messages.find((m): m is ToolMessage => m.role === 'tool' && m.name === 'task')
  check('explore 结果带类型标记', expResult?.meta?.kind === 'task' && expResult.meta.type === 'explore', JSON.stringify(expResult?.meta))

  // 子过程落盘 + 轨迹关联
  const subFile = subagentsFile(expSession.id)
  check('子过程落盘到独立文件', existsSync(subFile), subFile)
  const expTraj = buildTrajectory(sessions, expSession.id)
  const expRun = expTraj.subProcesses?.['call_exp_1']
  check('explore 正常执行只读仓库查询', Boolean(expRun?.messages.some((m) => m.role === 'tool' && m.name === 'repomind' && !m.isError)))
  check(
    '轨迹 JSON 关联子过程',
    Boolean(expRun && expRun.type === 'explore' && expRun.messages.length >= 3 && expRun.usage.output === 45),
    JSON.stringify(expRun ? { type: expRun.type, msgs: expRun.messages.length, usage: expRun.usage } : undefined)
  )

  // 记忆：模型通过 memory 工具写入，下一次请求的 system 里注入
  const memSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-model' })
  await runOnce(memSession.id, 'MEMORY-TOOL-SMOKE：记住我的偏好')
  const memFile = paths.memory()
  check('memory 工具写入记忆文件', existsSync(memFile) && readFileSync(memFile, 'utf8').includes('smoke 记忆'), existsSync(memFile) ? readFileSync(memFile, 'utf8') : '文件不存在')
  check('append 自动带日期', readFileSync(memFile, 'utf8').includes(`[${new Date().toISOString().slice(0, 10)}]`), '')

  // 第二个会话发消息：system 里应注入记忆
  const memSession2 = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-model' })
  await runOnce(memSession2.id, '随便跑一下（验证记忆注入）')
  check('新会话的 system 注入记忆', seenSystemLast.includes('smoke 记忆'), seenSystemLast.slice(0, 200))

  // rewrite 全量重写
  await runOnce(memSession2.id, 'MEMORY-REWRITE-SMOKE：重写记忆为精简版')
  check('rewrite 覆盖记忆', readFileSync(memFile, 'utf8').trim() === '- 精简版记忆', readFileSync(memFile, 'utf8'))
  // 清理：别把冒烟记忆带进真实环境（PI_DESKTOP_HOME 是临时目录，这里只是验证删除路径）
  sessions.remove(memSession2.id)
  check('删除会话不误删记忆文件', existsSync(memFile), '')

  // 删除会话清理子过程文件
  sessions.remove(expSession.id)
  check('删除会话清理子过程文件', !existsSync(subFile), '')

  console.log('\n[25] repomind 仓库图谱')
  const { repomindTool } = await import('../src/main/agent/tools/repomind')
  const graphWorkspace = join(workspace, 'graph-fixture')
  mkdirSync(graphWorkspace)
  const rmCtx = { workspace: graphWorkspace, shell: 'auto' as const, signal: new AbortController().signal, log: () => {} }
  writeFileSync(join(graphWorkspace, 'graph_base.ts'), 'export function sharedFn(): number {\n  return 1\n}\n', 'utf8')
  writeFileSync(join(graphWorkspace, 'graph_user.ts'), 'import { sharedFn } from "./graph_base"\nexport const useIt = () => sharedFn()\n', 'utf8')

  const rmStats = await repomindTool.run({ action: 'stats' }, rmCtx)
  check('repomind stats 含文件与依赖', !rmStats.isError && rmStats.content.includes('graph_base.ts'), rmStats.content.slice(0, 200))

  const rmDeps = await repomindTool.run({ action: 'deps', target: 'graph_user.ts' }, rmCtx)
  check('deps 列出引用', rmDeps.content.includes('graph_base.ts'), rmDeps.content)

  const rmUsedBy = await repomindTool.run({ action: 'usedby', target: 'graph_base.ts' }, rmCtx)
  check('usedby 反向查询', rmUsedBy.content.includes('graph_user.ts'), rmUsedBy.content)

  const rmSym = await repomindTool.run({ action: 'symbol', target: 'sharedFn' }, rmCtx)
  check('symbol 定位定义', rmSym.content.includes('graph_base.ts') && rmSym.content.includes('[func]'), rmSym.content)

  const rmRebuild = await repomindTool.run({ action: 'rebuild' }, rmCtx)
  check('rebuild 正常', !rmRebuild.isError && rmRebuild.content.includes('已重建'), rmRebuild.content)

  console.log('\n[26] MemoryGraph 与全息记忆')
  const { memoryTool } = await import('../src/main/agent/tools/memory')
  // 两条记忆 + link + related（图扩展召回）
  const mgA = await memoryTool.run({ action: 'append', content: '记住：build 脚本必须带 ELECTRON 镜像变量' }, rmCtx)
  const mgB = await memoryTool.run({ action: 'append', content: '记住：winCodeSign 缓存目录损坏会导致打包失败' }, rmCtx)
  const idA = /\((m\d+)\)/.exec(mgA.content)?.[1] ?? ''
  const idB = /\((m\d+)\)/.exec(mgB.content)?.[1] ?? ''
  check('append 返回条目 id', /^m\d+$/.test(idA) && /^m\d+$/.test(idB) && idA !== idB, `${idA},${idB}`)

  const holoJson = JSON.parse(readFileSync(join(paths.memory().replace('MEMORY.md', ''), 'memory-holo.json'), 'utf8')) as Record<string, { session?: string; cwd?: string; at: number }>
  check('全息元数据记录会话与目录', Boolean(holoJson[idA]?.cwd?.includes('pidesktop-smoke')), JSON.stringify(holoJson[idA]))

  const mgLink = await memoryTool.run({ action: 'link', ids: `${idA} ${idB}`, relation: 'same-build-chain' }, rmCtx)
  check('link 建边', !mgLink.isError, mgLink.content)

  // related：查询与 A 相关的词 → B 通过图扩展也应出现
  const mgRelated = await memoryTool.run({ action: 'related', content: 'build 镜像变量' }, rmCtx)
  check(
    'related 召回直接命中与图扩展',
    mgRelated.content.includes(idA) && mgRelated.content.includes(idB) && mgRelated.content.includes('score'),
    mgRelated.content
  )

  // rewrite 清理失效条目的图与全息
  await memoryTool.run({ action: 'rewrite', content: `- (${idA}) [${new Date().toISOString().slice(0, 10)}] 只保留这条` }, rmCtx)
  const graphAfter = JSON.parse(readFileSync(join(paths.memory().replace('MEMORY.md', ''), 'memory-graph.json'), 'utf8')) as { edges: unknown[] }
  check('rewrite 清理失效边', graphAfter.edges.length === 0, JSON.stringify(graphAfter))

  // 回归：rewrite 内容里手写高 id（m50），append 必须跳过它分到 m51，不得撞号
  await memoryTool.run({ action: 'rewrite', content: `- (m50) [${new Date().toISOString().slice(0, 10)}] 手写高 id 的条目` }, rmCtx)
  const mgAfter = await memoryTool.run({ action: 'append', content: 'rewrite 之后的新条目' }, rmCtx)
  const newId = /\((m\d+)\)/.exec(mgAfter.content)?.[1] ?? ''
  check('rewrite 后 nextId 防撞号', newId === 'm51', `new id=${newId}（期望 m51）`)

  console.log('\n[26b] 子过程落盘截断')
  // 子任务 bash 产生 9KB 输出：落盘应截到 8KB（+标记），父会话同位置保持完整
  const bigSession = sessions.create(workspace, { profileId: 'deepseek', model: 'mock-model' })
  await runOnce(bigSession.id, 'SUBTASK-BIG-SMOKE：派生子智能体跑大输出命令')
  const bigCallId = 'call_big_1'
  const bigFile = subagentsFile(bigSession.id)
  const bigLines = existsSync(bigFile)
    ? readFileSync(bigFile, 'utf8').split('\n').filter((l) => l.includes(`"${bigCallId}"`))
    : []
  const bigRecord = bigLines.length ? (JSON.parse(bigLines[0]) as { messages: { role: string; name?: string; content: string }[] }) : null
  const bigClipped = bigRecord?.messages.find((m) => m.name === 'bash')
  check(
    '子过程落盘时工具输出截断',
    Boolean(bigClipped && bigClipped.content.length < 9000 && bigClipped.content.includes('已截断')),
    bigClipped ? `落盘长度 ${bigClipped.content.length}` : '记录缺失'
  )
  check(
    '子循环上下文的工具输出保持完整',
    subToolMaxLen >= 9000,
    `子请求 tool 最大长度 ${subToolMaxLen}`
  )

  console.log('\n[27] 终端版 CLI')
  const cliEntry = join(__dirname, '..', 'out', 'main', 'cli.js')
  if (!existsSync(cliEntry)) {
    // CLI 用例跑的是构建产物；单独 npm run smoke（未 build）时跳过而不是整场失败
    console.log('  - 跳过（未找到构建产物 out/main/cli.js，请先 npm run build）')
  } else {
  // 独立 home：预写指向 mock 的 config，CLI 从头跑一轮真实对话
  const cliHome = join(home, 'cli-home')
  mkdirSync(join(cliHome, 'sessions'), { recursive: true })
  writeFileSync(
    join(cliHome, 'config.json'),
    JSON.stringify(
      {
        version: 2,
        lastCwd: '',
        activeProfileId: 'deepseek',
        model: 'mock-model',
        temperature: 0.2,
        maxTokens: 0,
        shell: 'auto',
        thinking: 'high',
        profiles: [{ id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: mock.url, apiKey: 'plain:ZGVtbw==', keyProtected: false, models: [{ id: 'mock-model' }] }]
      },
      null,
      2
    )
  )
  const cliProc = await new Promise<{ out: string; code: number | null }>((resolveP) => {
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    // cwd 设为 cliHome：/export 把轨迹写到那里，不污染仓库目录
    const child = spawn(process.execPath, [cliEntry, '--home', cliHome], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: cliHome
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    // 第一条消息触发 CALLS 分支（四个工具）+ 第二轮文本；随后跑几条命令路径
    child.stdin.write('创建 demo/hello.txt，把 world 改成 pi，再运行 echo\n')
    child.stdin.write('/thinking max\n')
    child.stdin.write('/sessions\n')
    child.stdin.write('/export json\n')
    const deadline = setTimeout(() => {
      child.kill()
      resolveP({ out, code: null })
    }, 45_000)
    // 终态判定：最终回复 + 命令输出都出现后再等输出静默（pipe 刷新），否则退出会丢工具行
    let lastLen = -1
    let quietRounds = 0
    const poll = setInterval(() => {
      if (out.includes('全部完成') && out.includes('轨迹已导出') && out.length === lastLen) {
        quietRounds++
        if (quietRounds >= 4) {
          clearInterval(poll)
          clearTimeout(deadline)
          child.stdin.write('/quit\n')
          return
        }
      } else {
        quietRounds = 0
      }
      lastLen = out.length
    }, 150)
    child.on('exit', (code) => {
      clearInterval(poll)
      clearTimeout(deadline)
      resolveP({ out, code })
    })
  })
  if (!cliProc.out.includes('全部完成')) console.log('  [dbg] FULL OUT:\n' + cliProc.out)
  check('CLI 完成一轮工具对话', cliProc.out.includes('⏺ bash') && cliProc.out.includes('全部完成'), cliProc.out.slice(-300))
  check('CLI 渲染工具结果与用量', /✓.*bash/.test(cliProc.out) && cliProc.out.includes('in 120 / out 40'), cliProc.out.slice(-400))
  check('CLI 会话已持久化', existsSync(join(cliHome, 'sessions')) && readdirSync(join(cliHome, 'sessions')).some((f) => f.endsWith('.jsonl')), '')
  // 命令路径：/thinking /sessions /export
  check('CLI 思考强度命令', cliProc.out.includes('思考 max') || /思考强度.*max/.test(cliProc.out), cliProc.out.slice(0, 600))
  check('CLI 导出轨迹命令', cliProc.out.includes('轨迹已导出'), `out含导出提示=${cliProc.out.includes('轨迹已导出')} 文件=${readdirSync(cliHome).filter((f) => f.startsWith('trajectory')).join(',')}`)
  }

  /* ---------------- [29] OpenAI OAuth：PKCE / 交换 / 刷新 / 登录流 / 存储 ---------------- */
  {
    const { createHash } = await import('node:crypto')
    const { makePkce, decodeJwt, refreshTokens, startLogin, resolveBearer } = await import('../src/main/oauth')

    // PKCE：challenge 可由 verifier 复算（S256）
    const b64u = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const { verifier, challenge } = makePkce()
    check('PKCE challenge 正确', verifier.length >= 40 && challenge === b64u(createHash('sha256').update(verifier).digest()))

    // JWT payload 解码（不验签，读 exp/email）
    const jwt = `h.${Buffer.from(JSON.stringify({ exp: 123, email: 'a@b.c' })).toString('base64url')}.s`
    const decoded = decodeJwt(jwt)
    check('JWT payload 解码', Boolean(decoded && decoded.exp === 123 && decoded.email === 'a@b.c'))

    // 假认证服务：/oauth/token 处理 authorization_code 与 refresh_token
    const seenBodies: Record<string, string>[] = []
    const mkAccess = (email: string, expSec: number): string =>
      `h.${Buffer.from(JSON.stringify({ exp: expSec, email })).toString('base64url')}.s`
    const authSrv = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const srv = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const parsed = JSON.parse(body) as Record<string, string>
          seenBodies.push(parsed)
          res.writeHead(200, { 'content-type': 'application/json' })
          if (parsed.grant_type === 'authorization_code') {
            res.end(
              JSON.stringify({
                access_token: mkAccess('frank@example.com', Math.floor(Date.now() / 1000) + 3600),
                refresh_token: 'r1',
                id_token: `h.${Buffer.from(JSON.stringify({ email: 'frank@example.com' })).toString('base64url')}.s`
              })
            )
          } else {
            res.end(
              JSON.stringify({
                access_token: mkAccess('frank@example.com', Math.floor(Date.now() / 1000) + 7200),
                refresh_token: 'r2'
              })
            )
          }
        })
      })
      srv.listen(38471, '127.0.0.1', () => {
        resolve({ url: 'http://127.0.0.1:38471', close: () => srv.close() })
      })
    })

    // 完整登录流：本地回调（固定端口）→ 模拟浏览器带 code 回跳 → 换 token
    const LOGIN_PORT = 24555
    let capturedUrl = ''
    const login = startLogin({
      authBase: authSrv.url,
      port: LOGIN_PORT,
      timeoutMs: 5000,
      open: (url) => {
        capturedUrl = url
      }
    })
    await new Promise((r) => setTimeout(r, 200)) // 等回调服务就绪
    const authorizeUrl = new URL(capturedUrl)
    const state = authorizeUrl.searchParams.get('state') ?? ''
    const challengeParam = authorizeUrl.searchParams.get('code_challenge') ?? ''
    check(
      '授权 URL 参数完整',
      authorizeUrl.searchParams.get('code_challenge_method') === 'S256' && challengeParam.length > 20 && Boolean(state),
      capturedUrl.slice(0, 120)
    )
    await fetch(`http://127.0.0.1:${LOGIN_PORT}/auth/callback?code=abc123&state=${encodeURIComponent(state)}`)
    const tokens = await login.promise
    check('登录流换到 token', tokens.refreshToken === 'r1' && tokens.account === 'frank@example.com', JSON.stringify(tokens).slice(0, 120))
    const bodyVerifier = String(seenBodies[0]?.code_verifier ?? '')
    check('code_verifier 与 challenge 匹配', bodyVerifier.length > 0 && b64u(createHash('sha256').update(bodyVerifier).digest()) === challengeParam)

    // 错误 state 拒绝（先挂 catch 再触发回调，避免 unhandled rejection）
    let stateRejected = false
    const badLogin = startLogin({ authBase: authSrv.url, port: LOGIN_PORT, timeoutMs: 5000, open: () => {} })
    const badSettled = badLogin.promise.then(
      () => 'resolved',
      (err) => {
        stateRejected = (err as Error).message.includes('state')
        return 'rejected'
      }
    )
    await new Promise((r) => setTimeout(r, 150))
    await fetch(`http://127.0.0.1:${LOGIN_PORT}/auth/callback?code=xyz&state=tampered`)
    await badSettled
    badLogin.cancel()
    check('回调 state 不匹配被拒绝', stateRejected)

    // 存进配置：PublicProfile 只报状态，不泄露 token
    config.patch({
      profiles: [{ id: 'openai-codex', protocol: 'responses', baseUrl: 'https://chatgpt.com/backend-api/codex' }]
    })
    config.setOAuth('openai-codex', tokens)
    const pub = config.toPublic()
    const codexPub = pub.profiles.find((p) => p.id === 'openai-codex')
    check(
      'OAuth 状态进 PublicProfile',
      Boolean(codexPub?.oauth?.connected && codexPub.oauth.account === 'frank@example.com'),
      JSON.stringify(codexPub?.oauth)
    )
    check(
      '公开配置不泄露 token',
      !JSON.stringify(pub).includes(tokens.accessToken.slice(4)) && !JSON.stringify(pub).includes('"r1"'),
      'token 出现在 toPublic 输出里'
    )

    // refresh：grant_type 与轮换
    const refreshed = await refreshTokens('r0', { authBase: authSrv.url })
    check('refresh token 轮换', refreshed.refreshToken === 'r2' && seenBodies[seenBodies.length - 1].grant_type === 'refresh_token')

    // resolveBearer：过期 → 自动刷新并写回配置（注入假端点，不打真实服务）
    config.setOAuth('openai-codex', { accessToken: 'expired', refreshToken: 'r-old', expiresAt: Date.now() - 1000 })
    const bearer = await resolveBearer(config, config.profileById('openai-codex')!, { authBase: authSrv.url })
    check(
      '过期自动刷新拿新 token',
      bearer.startsWith('h.') && bearer !== 'expired' && config.oauthFor('openai-codex')?.refreshToken === 'r2',
      bearer.slice(0, 24)
    )
    authSrv.close()
  }

  /* ---------------- [30] Responses 协议适配器：请求映射 + SSE 事件流解析 ---------------- */
  {
    const { createResponsesProvider } = await import('../src/main/agent/providers/responses')

    let seenBody: Record<string, unknown> | null = null
    let seenAuth = ''
    const srv = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const s = createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          seenBody = JSON.parse(body) as Record<string, unknown>
          seenAuth = String(req.headers.authorization ?? '')
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const events: [string, Record<string, unknown>][] = [
            ['response.reasoning_summary_text.delta', { delta: '想想' }],
            ['response.output_item.added', { item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'bash' } }],
            ['response.function_call_arguments.delta', { item_id: 'fc_1', delta: '{"command":"echo' }],
            ['response.function_call_arguments.delta', { item_id: 'fc_1', delta: ' resp-ok"}' }],
            ['response.output_item.done', { item: { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'bash', arguments: '{"command":"echo resp-ok"}' } }],
            ['response.output_text.delta', { delta: '马上执行' }],
            ['response.completed', { response: { usage: { input_tokens: 33, output_tokens: 11 }, status: 'completed' } }]
          ]
          for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
          res.end()
        })
      })
      s.listen(38472, '127.0.0.1', () => {
        resolve({ url: 'http://127.0.0.1:38472', close: () => s.close() })
      })
    })

    let text = ''
    let thinking = ''
    const result = await createResponsesProvider(srv.url, 'oauth-token').stream({
      system: 'sys',
      messages: [{ role: 'user' as const, id: 'u1', ts: Date.now(), text: 'RESP-SMOKE' }],
      tools: [],
      model: 'gpt-5.1-codex',
      temperature: 0,
      thinking: 'max',
      maxTokens: 4096,
      signal: new AbortController().signal,
      onTextDelta: (t) => (text += t),
      onThinkingDelta: (t) => (thinking += t)
    })
    check('Responses 文本与思考流', text === '马上执行' && thinking === '想想', `text=${text} think=${thinking}`)
    const call = result.blocks.find((b) => b.type === 'tool_use') as { name?: string; input?: { command?: string } } | undefined
    check(
      'Responses 工具调用拼装',
      Boolean(call && call.name === 'bash' && call.input && (call.input as { command?: string }).command === 'echo resp-ok'),
      JSON.stringify(result.blocks)
    )
    check('Responses 停机与用量', result.stopReason === 'toolUse' && result.usage?.input === 33 && result.usage?.output === 11, JSON.stringify({ stop: result.stopReason, usage: result.usage }))
    const body = seenBody as unknown as Record<string, unknown>
    const input = body.input as { role?: string; content?: { type?: string; text?: string }[] }[]
    check(
      'Responses 请求映射',
      body.instructions === 'sys' &&
        seenAuth === 'Bearer oauth-token' &&
        (body.reasoning as { effort?: string } | undefined)?.effort === 'high' &&
        body.max_output_tokens === 4096 &&
        input?.[0]?.content?.[0]?.type === 'input_text',
      JSON.stringify(body).slice(0, 200)
    )
    srv.close()
  }

  /* ---------------- [31] 上下文压缩：摘要新分支 + 原分支保留 + 继续对话 ---------------- */
  {
    const compactDir = join(workspace, 'compact-proj')
    mkdirSync(compactDir, { recursive: true })
    const sid = sessions.create(compactDir, { profileId: 'deepseek', model: 'mock-small' }).id
    const now = Date.now()
    sessions.append(sid, { role: 'user', id: 'cu1', ts: now - 4000, text: 'COMPACT-SMOKE 开始' })
    sessions.append(sid, {
      role: 'assistant', id: 'ca1', ts: now - 3000, model: 'mock-small', provider: 'openai',
      stopReason: 'stop', usage: { input: 100, output: 20 }, blocks: [{ type: 'text', text: '干活了。' }]
    })
    sessions.append(sid, { role: 'user', id: 'cu2', ts: now - 2000, text: '继续' })
    sessions.append(sid, {
      role: 'assistant', id: 'ca2', ts: now - 1000, model: 'mock-small', provider: 'openai',
      stopReason: 'stop', usage: { input: 120, output: 30 }, blocks: [{ type: 'text', text: '又干活了。' }]
    })
    const before = sessions.view(sid).messages
    check('压缩前历史就绪', before.length === 4, `${before.length}`)

    await runner.compact(sid)

    const after = sessions.view(sid).messages
    const summaryText = (after[0] as { text?: string } | undefined)?.text ?? ''
    check(
      '压缩后分支只剩摘要根',
      after.length === 1 && after[0]?.role === 'user' && summaryText.includes('上下文压缩摘要'),
      JSON.stringify(after.map((m) => m.role))
    )
    check('摘要来自模型总结', summaryText.includes('任务目标') && summaryText.includes('跑通冒烟'), summaryText.slice(0, 80))

    // 原分支完整保留：把 leaf 切回旧链，历史恢复
    sessions.setLeaf(sid, 'ca2')
    const restored = sessions.view(sid).messages
    check('原分支完整保留', restored.length === 4 && restored.some((m) => (m as { text?: string }).text === 'COMPACT-SMOKE 开始'), `${restored.length}`)

    // 压缩后的新分支可以继续对话：请求已发出，且新分支以摘要为起点
    sessions.setLeaf(sid, after[0]!.id)
    seenLastUserContent.length = 0
    const sendRes = runner.send(sid, '压缩后继续')
    await new Promise((r) => setTimeout(r, 700))
    const final = sessions.view(sid).messages
    check(
      '压缩后可继续对话',
      sendRes.queued === false &&
        seenLastUserContent.some((c) => c.includes('压缩后继续')) &&
        final.length > 1 &&
        Boolean((final[0] as { text?: string }).text?.includes('上下文压缩摘要')),
      `seen=${seenLastUserContent.length} final=${final.length}`
    )

    /* 压缩期间发消息：压缩占着 active 租约，send 必须排队，
       而不是并发起一个会跟摘要新根抢 leaf 的 run（否则用户那句话会从上下文里消失） */
    {
      const raceDir = join(workspace, 'compact-race')
      mkdirSync(raceDir, { recursive: true })
      const raceSid = sessions.create(raceDir, { profileId: 'deepseek', model: 'mock-small' }).id
      const t = Date.now()
      sessions.append(raceSid, { role: 'user', id: 'ru1', ts: t - 2000, text: 'RACE 起点' })
      sessions.append(raceSid, {
        role: 'assistant', id: 'ra1', ts: t - 1000, model: 'mock-small', provider: 'openai',
        stopReason: 'stop', usage: { input: 10, output: 5 }, blocks: [{ type: 'text', text: '收到。' }]
      })

      const pending = runner.compact(raceSid)
      // 压缩的模型往返还没回来就发送：应当排队，而不是另起一个 run
      const racedSend = runner.send(raceSid, 'RACE 压缩中发的话')
      check('压缩期间发送进入排队', racedSend.queued === true, JSON.stringify(racedSend))
      check('压缩期间会话仍视为运行中', runner.isRunning(raceSid), 'isRunning=false')

      let again = ''
      try {
        await runner.compact(raceSid)
      } catch (err) {
        again = (err as Error).message
      }
      check('压缩进行中拒绝重复压缩', again.includes('运行中') || again.includes('正在压缩'), again || '(未拒绝)')

      await pending
      await new Promise((r) => setTimeout(r, 700))

      const msgs = sessions.view(raceSid).messages
      const head = (msgs[0] as { text?: string } | undefined)?.text ?? ''
      check(
        '压缩期间排队的消息落在摘要分支上',
        msgs[0]?.role === 'user' &&
          head.includes('上下文压缩摘要') &&
          msgs.some((m) => (m as { text?: string }).text === 'RACE 压缩中发的话') &&
          msgs.length >= 3,
        JSON.stringify(msgs.map((m) => `${m.role}:${((m as { text?: string }).text ?? '').slice(0, 8)}`))
      )
    }

    /* 压缩可被 Esc 打断：原分支不动，排队消息照常落盘（不能因为中止就吞掉用户的话） */
    {
      const abortDir = join(workspace, 'compact-abort')
      mkdirSync(abortDir, { recursive: true })
      const abortSid = sessions.create(abortDir, { profileId: 'deepseek', model: 'mock-small' }).id
      sessions.append(abortSid, { role: 'user', id: 'au1', ts: Date.now() - 2000, text: 'ABORT 起点' })
      sessions.append(abortSid, {
        role: 'assistant', id: 'aa1', ts: Date.now() - 1000, model: 'mock-small', provider: 'openai',
        stopReason: 'stop', usage: { input: 10, output: 5 }, blocks: [{ type: 'text', text: '收到。' }]
      })

      const pendingAbort = runner.compact(abortSid)
      runner.send(abortSid, 'ABORT 排队的话')
      runner.abort(abortSid)
      await pendingAbort

      const kept = sessions.view(abortSid).messages
      check(
        '压缩被中止：原分支不变、排队消息已落盘',
        kept.length === 3 &&
          !((kept[0] as { text?: string } | undefined)?.text ?? '').includes('上下文压缩摘要') &&
          kept.some((m) => (m as { text?: string }).text === 'ABORT 排队的话'),
        JSON.stringify(kept.map((m) => `${m.role}:${((m as { text?: string }).text ?? '').slice(0, 8)}`))
      )
    }
  }

  /* ---------------- [32] 记忆检索 / nudge / 技能 / fetch / USER / SOUL ---------------- */
  {
    const { buildMemoryInjection, tokenize, scoreEntries, noteRunEnd, consumeNudge, noteMemoryWrite, parseEntries } =
      await import('../src/main/agent/memory-store')
    const { buildSystemPrompt } = await import('../src/main/agent/prompt')

    // 1) 分词：拉丁整词 + CJK 2-gram
    const toks = tokenize('数据库 migration 迁移脚本')
    check(
      '记忆分词（拉丁 + CJK 2-gram）',
      toks.includes('migration') && toks.includes('数据') && toks.includes('据库') && toks.includes('迁移'),
      JSON.stringify(toks)
    )

    // 2) 检索打分：相关条目排最前（m2 谈数据库迁移）
    const entries = parseEntries(
      [
        '- (m1) [2026-11-01] 前端构建用 vite，不要用 webpack',
        '- (m2) [2026-11-02] 数据库迁移脚本要先备份再跑，直接跑会锁表',
        '- (m3) [2026-11-03] 用户偏好中文回复'
      ].join('\n')
    )
    const ranked = scoreEntries('数据库迁移 报错', entries, { nextId: 4, edges: [] })
    check('记忆检索命中相关条目', ranked.length > 0 && ranked[0].entry.id === 'm2', JSON.stringify(ranked.map((r) => r.entry.id)))

    // 3) 超限注入：检索式（相关 + 最新 + 提示行），长度受控
    const filler = Array.from({ length: 90 }, (_, i) => `- (mf${i}) [2026-11-01] 填充条目 ${i} 与一些无关内容 padding`).join('\n')
    writeFileSync(
      paths.memory(),
      `- (m2) [2026-11-02] 数据库迁移脚本要先备份再跑\n${filler}\n- (m9) [2026-11-08] 最新一条：发布走 npm run dist:win\n`,
      'utf8'
    )
    const injection = buildMemoryInjection('数据库迁移怎么办', 2000)
    check(
      '检索式注入（相关 + 最新）',
      injection.includes('数据库迁移脚本') && injection.includes('最新一条') && injection.includes('按相关度'),
      injection.slice(0, 90)
    )
    check('检索式注入长度受控', injection.length <= 2100, `${injection.length}`)

    // 4) nudge：用过工具未写记忆 → 下轮提醒；写过 → 不提醒
    noteRunEnd(true)
    check('nudge 触发', consumeNudge() === true)
    noteMemoryWrite()
    noteRunEnd(true)
    check('写过记忆后不再 nudge', consumeNudge() === false)

    // 工具直调上下文
    const ws = join(workspace, 'skills-proj')
    mkdirSync(ws, { recursive: true })
    const toolCtx = {
      workspace: ws,
      shell: 'bash' as const,
      signal: new AbortController().signal,
      log: () => {},
      sessionId: 's_tool',
      callId: ''
    }

    // 5) 技能：write → list/read
    const sw = await executeTool(
      'skills',
      { action: 'write', id: 'release-check', description: '发布前检查清单', content: '1. 跑测试\n2. npm run build\n3. 改版本号' },
      toolCtx
    )
    check('skills write 创建技能', !sw.isError, sw.content)
    const sl = await executeTool('skills', { action: 'list' }, toolCtx)
    check('skills list 含新技能', !sl.isError && sl.content.includes('release-check'), sl.content.slice(0, 80))
    const sr = await executeTool('skills', { action: 'read', id: 'release-check' }, toolCtx)
    check('skills read 返回正文', !sr.isError && sr.content.includes('npm run build'), sr.content.slice(0, 60))

    // 6) fetch：HTML 提取正文 / 拒绝非 http
    const fsrv = await new Promise<{ url: string; close: () => void }>((resolve) => {
      const s = createServer((req, res) => {
        if ((req.url ?? '') === '/text') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('plain body')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><head><title>Smoke Page</title><script>alert(1)</script></head><body><p>这是正文内容 &amp; 实体</p></body></html>')
      })
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address() as { port: number }
        resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => s.close() })
      })
    })
    const fr = await executeTool('fetch', { url: `${fsrv.url}/page` }, toolCtx)
    check(
      'fetch HTML 提取正文',
      !fr.isError && fr.content.includes('Smoke Page') && fr.content.includes('这是正文内容 & 实体') && !fr.content.includes('alert'),
      fr.content.slice(0, 80)
    )
    const bad = await executeTool('fetch', { url: 'ftp://example.com/x' }, toolCtx)
    check('fetch 拒绝非 http(s)', bad.isError, bad.content)
    fsrv.close()

    // 7) USER.md / SOUL.md / 技能索引 注入 system prompt
    const uw = await executeTool('memory', { action: 'append', scope: 'user', content: '用户是资深开发者，喜欢简洁回答' }, toolCtx)
    check('memory scope=user 写入', !uw.isError, uw.content)
    writeFileSync(paths.soul(), '回答保持极简。', 'utf8')
    const sys = buildSystemPrompt(ws, '')
    check('USER.md 注入', sys.includes('User profile') && sys.includes('资深开发者'))
    check('SOUL.md 注入', sys.includes('Persona') && sys.includes('回答保持极简'))
    check('技能索引注入', sys.includes('Skills index') && sys.includes('release-check'))
    check('新工具进提示词', sys.includes('- fetch(url)') && sys.includes('skills(action'))
    rmSync(paths.soul(), { force: true })
    const sys2 = buildSystemPrompt(ws, '')
    check('SOUL 不存在则不注入', !sys2.includes('Persona'))
  }

  /* ---------------- [33] ZCode 借鉴：插件钩子 / ask 桥 / cron / 会话搜索 / chart ---------------- */
  {
    const ws33 = join(workspace, 'skills-proj')
    const ctx33 = {
      workspace: ws33,
      shell: 'auto' as const,
      signal: new AbortController().signal,
      log: () => {},
      sessionId: 's_hook',
      callId: ''
    }

    // 1) 插件 beforeTool 钩子：deny 拦截 + modify 改参（装进真实数据目录的 plugins/）
    const { pluginHost } = await import('../src/main/plugins')
    const { paths: p33 } = await import('../src/main/paths')
    const guardDir = `${p33.plugins()}/guard`
    mkdirSync(guardDir, { recursive: true })
    writeFileSync(`${guardDir}/plugin.json`, JSON.stringify({ name: 'guard', version: '1.0.0' }), 'utf8')
    writeFileSync(
      `${guardDir}/index.js`,
      'module.exports = { hooks: { beforeTool({ tool, input }) { if (tool === "bash" && String(input.command || "").includes("rm -rf")) return { action: "deny", reason: "禁止递归删除" }; if (tool === "write" && String(input.path || "").startsWith("logs/")) return { action: "modify", input: { ...input, path: "archive/" + input.path } } } } }'
    )
    pluginHost.reload()
    const deny = pluginHost.runBeforeTool('bash', { command: 'rm -rf /tmp/x' })
    check('钩子 deny 拦截', deny.denied === '禁止递归删除', JSON.stringify(deny))
    const mod = pluginHost.runBeforeTool('write', { path: 'logs/a.txt', content: 'x' })
    check('钩子 modify 改参', !mod.denied && (mod.input as { path?: string }).path === 'archive/logs/a.txt', JSON.stringify(mod.input))
    const pass = pluginHost.runBeforeTool('read', { path: 'a.txt' })
    check('钩子放行', !pass.denied && (pass.input as { path?: string }).path === 'a.txt')
    // executeTool 全链路走钩子（bash 被拦 → 工具结果错误）
    const blocked = await executeTool('bash', { command: 'echo rm -rf demo' }, ctx33)
    check('executeTool 经过钩子', blocked.isError && blocked.content.includes('被插件拦截'), blocked.content)
    rmSync(guardDir, { recursive: true, force: true })
    pluginHost.reload()

    // 2) ask 桥：提问挂起 → 回填 → 结果（不经渲染层）
    const { askTool, answerAsk, bindAskDelivery } = await import('../src/main/agent/tools/ask')
    const delivered: { callId: string; question: string; options: string[] }[] = []
    bindAskDelivery((payload) => delivered.push(payload))
    const askPromise = askTool.run({ question: '选哪个方案？', options: ['方案 A', '方案 B'] }, { ...ctx33, callId: 'ask_1' })
    await new Promise((r) => setTimeout(r, 50))
    check('ask 事件已投递', delivered.length === 1 && delivered[0].options.length === 2, JSON.stringify(delivered))
    check('ask 回填命中', answerAsk(delivered[0].callId, 0, '方案 A') === true)
    const askRes = await askPromise
    check('ask 结果带用户选择', !askRes.isError && askRes.content.includes('方案 A'), askRes.content)

    // 3) cron：解析/匹配/OR 语义/非法拒绝
    const { parseCron, cronMatches } = await import('../src/main/scheduler')
    check('cron 解析合法', parseCron('0 9 * * 1-5') !== null && parseCron('*/15 * * * *') !== null)
    check('cron 拒绝非法', parseCron('99 * * * *') === null && parseCron('0 9 * *') === null)
    // 2026-11-09 是周一
    const monday = new Date(2026, 10, 9, 9, 0, 0)
    check('cron 工作日命中', cronMatches('0 9 * * 1-5', monday) === true)
    check('cron 周末不命中', cronMatches('0 9 * * 1-5', new Date(2026, 10, 8, 9, 0)) === false)
    // dom 与 dow 都受限时 OR：1 月 1 日（周四）命中 "0 0 1 * 1"
    check('cron dom/dow OR 语义', cronMatches('0 0 1 * 1', new Date(2026, 0, 1, 0, 0)) === true)

    // 4) 会话搜索：扫 JSONL 打分
    const { searchSessions } = await import('../src/main/session-search')
    const searchDir = sessions.create(join(workspace, 'search-proj'), { profileId: 'deepseek', model: 'mock-small' }).id
    sessions.append(searchDir, { role: 'user', id: 'ss_u1', ts: Date.now() - 1000, text: '数据库迁移应该怎么跑' })
    sessions.append(searchDir, {
      role: 'assistant', id: 'ss_a1', ts: Date.now(), model: 'mock-small', provider: 'openai',
      stopReason: 'stop', usage: { input: 1, output: 1 }, blocks: [{ type: 'text', text: '先备份再跑迁移脚本，避免锁表。' }]
    })
    const all = sessions.list()
    const hits = searchSessions('数据库迁移 备份', all)
    check(
      '跨会话检索命中',
      hits.length > 0 && hits[0].sessionId === searchDir && hits[0].snippet.includes('迁移'),
      JSON.stringify(hits.slice(0, 2))
    )
    check('跨会话检索无查询返回空', searchSessions('', all).length === 0)

    // 5) chart：解析与几何
    const { parseChartSpec, chartGeometry, linePath } = await import('../src/shared/chart')
    const spec = parseChartSpec('{"type":"bar","title":"周报","labels":["一","二","三"],"values":[3,7,5]}')
    check('chart 解析合法', Boolean(spec && spec.type === 'bar' && spec.values.length === 3), JSON.stringify(spec))
    check('chart 拒绝坏数据', parseChartSpec('not json') === null && parseChartSpec('{"type":"pie","values":[1,2]}') === null && parseChartSpec('{"type":"bar","values":[1]}') === null)
    const geo = chartGeometry(spec!, 520, 160)
    check('chart 几何在界内', geo.bars.every((b) => b.x >= 10 && b.x + b.width <= 510 && b.y >= 10) && geo.max === 7 && geo.min === 3, JSON.stringify(geo.bars?.[0]))
    const line = parseChartSpec('{"type":"line","values":[5,1,9]}')
    const lp = linePath(chartGeometry(line!, 300, 100).points)
    check('chart 折线 path', lp.startsWith('M') && lp.includes('L'), lp)
  }

  logger.close()
  const logDir = paths.logs()
  const logFiles = existsSync(logDir) ? readdirSync(logDir) : []
  check('日志已落盘', logFiles.length > 0, logDir)
  const logText = logFiles.length ? readFileSync(join(logDir, logFiles[0]), 'utf8') : ''
  check('日志包含 run 生命周期', logText.includes('run.start') && logText.includes('run.end'))
  check('日志包含工具记录', logText.includes('tool.bash') || logText.includes('tool.write'))

  await mock.close()

  console.log('\n[34] 边界与并发回归')
  const { runBoundaryRegressions } = await import('./boundary-regressions')
  await runBoundaryRegressions(home)
  const { runSystemRegressions } = await import('./system-regressions')
  runSystemRegressions()
  const { runAgentRegressions } = await import('./agent-regressions')
  await runAgentRegressions()

  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}  ·  运行目录 ${home}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err)
  process.exit(1)
})
