import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { AgentRunner } from '../src/main/agent/runner'
import { SessionStore } from '../src/main/agent/session'
import type { AgentTool } from '../src/main/agent/tools'
import { answerAsk, bindAskCloseDelivery, bindAskDelivery } from '../src/main/agent/tools/ask'
import { ConfigStore } from '../src/main/config'
import { Logger } from '../src/main/logger'
import { getDataDir, initPaths, paths } from '../src/main/paths'
import { pluginHost } from '../src/main/plugins'
import type { AgentEvent } from '../src/shared/types'

interface MockCall {
  id: string
  name: string
  input: Record<string, unknown>
}

interface MockRequest {
  tools: { function: { name: string } }[]
  messages: { role: string; content: string; tool_call_id?: string }[]
}

function response(text: string, calls: MockCall[] = []): Response {
  const payload = {
    choices: [{
      delta: {
        content: text,
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          function: { name: call.name, arguments: JSON.stringify(call.input) }
        }))
      },
      finish_reason: calls.length ? 'tool_calls' : 'stop'
    }]
  }
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  })
}

async function waitUntil(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    assert.ok(Date.now() < deadline, `等待超时：${description}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 在已初始化的测试数据目录中运行；请求经过真实 provider，但 fetch 仅返回本地夹具。 */
export async function runAgentRegressions(): Promise<void> {
  const root = mkdtempSync(join(getDataDir(), 'agent-regressions-'))
  const sessions = new SessionStore(paths.sessions())
  const config = new ConfigStore(undefined, join(root, 'config.json'))
  Object.assign(config.load(), {
    activeProfileId: 'regression-mock',
    model: 'mock-model',
    profiles: [{
      id: 'regression-mock', label: 'regression mock', protocol: 'openai',
      baseUrl: 'http://127.0.0.1/regressions', models: []
    }]
  })
  const log = new Logger('error')
  const events: AgentEvent[] = []
  const runner = new AgentRunner(sessions, config, log, (event) => events.push(event))
  const originalFetch = globalThis.fetch
  const originalTools = pluginHost.tools
  const originalInstructions = pluginHost.instructions
  const originalBeforeTool = pluginHost.runBeforeTool
  const hookCalls: string[] = []
  let pluginExecutions = 0
  const pluginProbe: AgentTool = {
    spec: { name: 'regression_plugin', description: 'Regression probe', parameters: { type: 'object', properties: {} } },
    async run() {
      pluginExecutions++
      return { content: 'plugin executed', isError: false }
    }
  }
  pluginHost.tools = () => [pluginProbe]
  pluginHost.instructions = () => ''
  pluginHost.runBeforeTool = (name, input) => {
    hookCalls.push(name)
    return { input }
  }

  const createSession = (name: string): { sid: string; workspace: string } => {
    const workspace = join(root, name)
    mkdirSync(workspace)
    return { sid: sessions.create(workspace).id, workspace }
  }

  const assertDone = (sid: string): void => {
    const endings = events.flatMap((event) => event.type === 'run_end' && event.sessionId === sid ? [event.status] : [])
    assert.deepEqual(endings, ['done'])
  }

  try {
    // 中止发生在模型请求期间：排队消息保存一次，直到用户再次发送才启动下一轮。
    {
      const runAbortScenario = async (attempt: string): Promise<void> => {
        let requests = 0
        let firstRequestReady = false
        globalThis.fetch = async (_url, init) => {
          requests++
          if (requests > 1) return response('continued')
          firstRequestReady = true
          return await new Promise<Response>((_resolve, reject) => {
            const abort = (): void => reject(new Error('mock request aborted'))
            if (init?.signal?.aborted) abort()
            else init?.signal?.addEventListener('abort', abort, { once: true })
          })
        }
        const { sid } = createSession('abort-queue-' + attempt)
        runner.send(sid, 'initial message')
        await waitUntil(() => firstRequestReady, '首个模型请求')
        assert.equal(runner.send(sid, 'queued message').queued, true)
        runner.abort(sid)
        await waitUntil(() => !runner.isRunning(sid), '中止完成')
        // 稳定窗口：若中止后仍会自动续跑，第二次请求必然落在这个窗口内
        await new Promise((resolve) => setTimeout(resolve, 150))
        assert.equal(requests, 1, '中止后不应重新请求模型')
        assert.deepEqual(
          events.flatMap((event) => event.type === 'run_end' && event.sessionId === sid ? [event.status] : []),
          ['aborted']
        )
        const userTexts = (): string[] => sessions.view(sid).messages.flatMap((message) => message.role === 'user' ? [message.text] : [])
        assert.deepEqual(userTexts(), ['initial message', 'queued message'])
        runner.send(sid, 'resume explicitly')
        await waitUntil(() => !runner.isRunning(sid), '用户重新发送后的运行')
        assert.equal(requests, 2)
        assert.deepEqual(userTexts(), ['initial message', 'queued message', 'resume explicitly'])
      }
      try {
        await runAbortScenario('a')
      } catch (err) {
        // 偶发竞态（完整冒烟高负载下中止时序可能漂移）：整段重试一次
        console.log('  ↻ 中止回归重试一次：' + (err as Error).message)
        await runAbortScenario('b')
      }
      console.log('  ✓ 中止后排队消息只保存一次，等待用户再次发送')
    }

    for (const type of ['explore', 'plan'] as const) {
      const { sid, workspace } = createSession(type)
      const original = 'export const READONLY_MARKER = true\n'
      writeFileSync(join(workspace, 'fixture.ts'), original)
      const forbidden: MockCall[] = [
        { id: 'denied-write', name: 'write', input: { path: 'forbidden-write.txt', content: 'changed' } },
        { id: 'denied-edit', name: 'edit', input: { path: 'fixture.ts', old_string: 'true', new_string: 'false' } },
        { id: 'denied-bash', name: 'bash', input: { command: 'echo forbidden > forbidden-shell.txt' } },
        { id: 'denied-memory', name: 'memory', input: { action: 'append', content: 'forbidden memory' } },
        { id: 'denied-skills', name: 'skills', input: { action: 'write', id: 'forbidden-skill', description: 'probe', content: 'probe' } },
        { id: 'denied-task', name: 'task', input: { prompt: 'nested task', label: 'nested' } },
        { id: 'denied-plugin', name: 'regression_plugin', input: {} }
      ]
      const childRequests: MockRequest[] = []
      let parentRequests = 0
      hookCalls.length = 0
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MockRequest
        const isChild = body.messages.some((message) => message.role === 'user' && message.content === `child-${type}`)
        if (!isChild) {
          parentRequests++
          return parentRequests === 1
            ? response('', [{ id: `parent-${type}`, name: 'task', input: { prompt: `child-${type}`, label: type, type } }])
            : response('parent done')
        }
        childRequests.push(body)
        if (childRequests.length === 1) return response('', forbidden)
        if (childRequests.length === 2) return response('', [
          { id: 'allowed-read', name: 'read', input: { path: 'fixture.ts' } },
          { id: 'allowed-query', name: 'repomind', input: { action: 'stats' } }
        ])
        return response('read-only research done')
      }
      runner.send(sid, `parent-${type}`)
      await waitUntil(() => !runner.isRunning(sid), `${type} 子任务`)
      assertDone(sid)
      assert.equal(childRequests.length, 3)
      const advertised = childRequests[0].tools.map((tool) => tool.function.name)
      assert.deepEqual(advertised.sort(), ['ask', 'fetch', 'read', 'repomind'])
      const results = childRequests[2].messages.filter((message) => message.role === 'tool')
      for (const call of forbidden) {
        assert.match(results.find((message) => message.tool_call_id === call.id)?.content ?? '', /未授权工具/)
        // 外部插件 hook 同样不应看到已经拒绝的调用；父级 task 是唯一例外。
        if (call.name !== 'task') assert.ok(!hookCalls.includes(call.name), `${call.name} 不应进入插件钩子`)
      }
      assert.equal(hookCalls.filter((name) => name === 'task').length, 1)
      assert.match(results.find((message) => message.tool_call_id === 'allowed-read')?.content ?? '', /READONLY_MARKER/)
      assert.match(results.find((message) => message.tool_call_id === 'allowed-query')?.content ?? '', /fixture\.ts/)
      assert.equal(readFileSync(join(workspace, 'fixture.ts'), 'utf8'), original)
      assert.equal(existsSync(join(workspace, 'forbidden-write.txt')), false)
      assert.equal(existsSync(join(workspace, 'forbidden-shell.txt')), false)
      assert.equal(pluginExecutions, 0)
      console.log(`  ✓ ${type} 拒绝未声明工具，正常 read/repomind 查询仍可执行`)
    }

    // general 保留 shell 执行能力，但仍不能嵌套 task 或使用插件工具。
    {
      const { sid } = createSession('general')
      const childRequests: MockRequest[] = []
      let parentRequests = 0
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MockRequest
        const isChild = body.messages.some((message) => message.role === 'user' && message.content === 'child-general')
        if (!isChild) {
          parentRequests++
          return parentRequests === 1
            ? response('', [{ id: 'parent-general', name: 'task', input: { prompt: 'child-general', label: 'general', type: 'general' } }])
            : response('parent done')
        }
        childRequests.push(body)
        if (childRequests.length === 1) return response('', [
          { id: 'general-bash', name: 'bash', input: { command: 'echo GENERAL_SHELL_OK' } },
          { id: 'general-nested', name: 'task', input: { prompt: 'nested', label: 'nested' } },
          { id: 'general-plugin', name: 'regression_plugin', input: {} }
        ])
        return response('general done')
      }
      runner.send(sid, 'parent-general')
      await waitUntil(() => !runner.isRunning(sid), 'general 子任务')
      assertDone(sid)
      assert.equal(childRequests.length, 2)
      const advertised = childRequests[0].tools.map((tool) => tool.function.name)
      assert.ok(advertised.includes('bash'))
      assert.ok(!advertised.includes('task') && !advertised.includes('regression_plugin'))
      const results = childRequests[1].messages.filter((message) => message.role === 'tool')
      const shellResult = results.find((message) => message.tool_call_id === 'general-bash')?.content ?? ''
      assert.match(shellResult, /GENERAL_SHELL_OK/)
      assert.match(shellResult, /exit 0/)
      for (const id of ['general-nested', 'general-plugin']) {
        assert.match(results.find((message) => message.tool_call_id === id)?.content ?? '', /未授权工具/)
      }
      assert.equal(pluginExecutions, 0)
      console.log('  ✓ general 保留 bash，同时拒绝嵌套 task 和插件工具')
    }

    // 两个子任务同时提问，即使模型复用了 tool call ID，UI 请求与回答也不能串线。
    {
      const { sid } = createSession('parallel-asks')
      const delivered: { sessionId: string; callId: string; question: string; options: string[] }[] = []
      const closed: { sessionId: string; callId: string }[] = []
      const childRequests = new Map<string, MockRequest[]>()
      let parentRequests = 0
      bindAskDelivery((payload) => delivered.push(payload))
      bindAskCloseDelivery((payload) => closed.push(payload))
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as MockRequest
        const child = body.messages.find((message) => message.role === 'user' && message.content.startsWith('ask-child-'))?.content
        if (!child) {
          parentRequests++
          return parentRequests === 1
            ? response('', ['alpha', 'beta'].map((name) => ({
              id: `task-${name}`, name: 'task', input: { prompt: `ask-child-${name}`, label: name, type: 'explore' }
            })))
            : response('both children done')
        }
        const requests = childRequests.get(child) ?? []
        requests.push(body)
        childRequests.set(child, requests)
        return requests.length === 1
          ? response('', [{ id: 'shared-model-call-id', name: 'ask', input: { question: child, options: ['A', 'B'] } }])
          : response(`${child} completed`)
      }
      runner.send(sid, 'ask-parent')
      await waitUntil(() => delivered.length === 2, '两个并行子任务均投递提问')
      assert.ok(runner.isRunning(sid))
      assert.deepEqual(closed, [], '回答前两个提问都应处于挂起状态')
      assert.ok(delivered.every((payload) => payload.sessionId === sid), '子任务提问应归属父会话')
      assert.equal(new Set(delivered.map((payload) => payload.callId)).size, 2, 'UI 请求 ID 不能复用模型 call ID')
      const alpha = delivered.find((payload) => payload.question === 'ask-child-alpha')!
      const beta = delivered.find((payload) => payload.question === 'ask-child-beta')!
      assert.ok(alpha && beta)

      // 先回答后投递的任务；第一个任务仍等待时，父运行不能提前结束。
      assert.equal(answerAsk(beta.callId, 1, 'B'), true)
      await waitUntil(() => childRequests.get('ask-child-beta')?.length === 2, 'beta 获取自己的回答并继续')
      assert.ok(runner.isRunning(sid))
      assert.equal(parentRequests, 1)
      assert.equal(childRequests.get('ask-child-alpha')?.length, 1)
      assert.deepEqual(closed, [{ sessionId: sid, callId: beta.callId }])
      assert.equal(answerAsk(alpha.callId, 0, 'A'), true)
      await waitUntil(() => !runner.isRunning(sid), '两个提问回答后父任务完成')
      assertDone(sid)
      assert.equal(parentRequests, 2)
      for (const [name, answer] of [['alpha', 'A'], ['beta', 'B']]) {
        const requests = childRequests.get(`ask-child-${name}`)!
        assert.equal(requests.length, 2)
        const toolResult = requests[1].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'shared-model-call-id')
        assert.equal(toolResult?.content, `用户选择了：${answer}`, '回答必须回到对应的子任务')
      }
      const reports = sessions.view(sid).messages.filter((message) => message.role === 'tool')
      assert.equal(reports.length, 2)
      assert.ok(reports.every((message) => message.role === 'tool' && !message.isError))
      assert.deepEqual(
        reports.flatMap((message) => message.role === 'tool' ? [message.content] : []).sort(),
        ['ask-child-alpha completed', 'ask-child-beta completed']
      )
      assert.deepEqual(closed, [{ sessionId: sid, callId: beta.callId }, { sessionId: sid, callId: alpha.callId }])
      assert.equal(answerAsk(alpha.callId, 0, 'again'), false)
      assert.equal(answerAsk(beta.callId, 1, 'again'), false)
      console.log('  ✓ 并行子任务 ask 归属父会话，相同模型 call ID 的回答互不串线')
    }
  } finally {
    runner.abortAll()
    try {
      await waitUntil(() => runner.runningIds().length === 0, '清理测试运行')
    } finally {
      globalThis.fetch = originalFetch
      pluginHost.tools = originalTools
      pluginHost.instructions = originalInstructions
      pluginHost.runBeforeTool = originalBeforeTool
      bindAskDelivery(null)
      bindAskCloseDelivery(null)
      log.close()
    }
  }
}

if (basename(process.argv[1] ?? '') === 'agent-regressions.ts') {
  initPaths(mkdtempSync(join(tmpdir(), 'pidesktop-agent-regressions-')))
  runAgentRegressions().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
