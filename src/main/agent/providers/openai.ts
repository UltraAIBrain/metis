import type { Block, Message, StopReason, ToolSpec, Usage } from '@shared/types'
import { AgentFailure, classifyHttp } from '../errors'
import { attachmentBase64, attachmentText } from '../../attachments'
import { ensureOk, request, safeJsonParse, sseData } from './sse'
import type { Provider, ProviderLog, StreamRequest, StreamResult } from './types'
import { isRenderable, isUnsupportedParamError, supportsEffort, textOf } from './types'

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** 用户消息里的附件 → 多段 content：图片走 data URL，文本附件内联成带标记的正文 */
async function userParts(m: Extract<Message, { role: 'user' }>): Promise<ContentPart[]> {
  const parts: ContentPart[] = []
  if (m.text) parts.push({ type: 'text', text: m.text })
  for (const a of m.attachments ?? []) {
    if (a.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${attachmentBase64(a)}` } })
    } else {
      parts.push({
        type: 'text',
        text: `[附件 ${a.name}]\n\`\`\`\n${attachmentText(a)}\n\`\`\``
      })
    }
  }
  return parts
}

async function convert(system: string, messages: Message[]): Promise<OpenAIMessage[]> {
  const out: OpenAIMessage[] = [{ role: 'system', content: system }]

  for (const m of messages) {
    if (!isRenderable(m)) continue

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.attachments?.length ? await userParts(m) : m.text })
      continue
    }

    if (m.role === 'assistant') {
      const text = textOf(m.blocks)
      const calls = m.blocks.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
      if (!calls.length) {
        out.push({ role: 'assistant', content: text })
        continue
      }
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) }
        }))
      })
      continue
    }

    out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
  }

  return out
}

interface ToolCallAcc {
  id: string
  name: string
  args: string
}

function mapFinish(reason: string | null | undefined, hasTools: boolean): StopReason {
  if (hasTools) return 'toolUse'
  if (reason === 'length') return 'maxTokens'
  if (reason === 'content_filter') return 'stop'
  return 'stop'
}

function usesCompletionTokens(model: string): boolean {
  return /(gpt[-_.]?[5-9]|o[1-9](?:[-_.]|$))/i.test(model)
}

export function createOpenAIProvider(baseUrl: string, apiKey: string, log?: ProviderLog): Provider {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

  return {
    id: 'openai',

    async stream(req: StreamRequest): Promise<StreamResult> {
      const completionTokens = usesCompletionTokens(req.model)
      const body: Record<string, unknown> = {
        model: req.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: await convert(req.system, req.messages),
        tools: req.tools.map((t: ToolSpec) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters }
        })),
        tool_choice: 'auto'
      }
      // 推理模型（与 reasoning_effort 同一套判定）不收 temperature，避免 DeepSeek-R1 / GLM 等
      // 推理模型因 temperature 被服务端 400；普通模型才带采样温度
      if (!supportsEffort(req.model)) body.temperature = req.temperature
      // 显式给出输出上限：推理模型的思考也算在里面，不给上限就只能听服务商默认值
      if (req.maxTokens && req.maxTokens > 0) {
        body[completionTokens ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
      }

      // 只在推理模型上带思考强度；不支持的老模型靠 400 兜底重试
      const wantsEffort = supportsEffort(req.model)
      if (wantsEffort) body.reasoning_effort = req.thinking

      const post = (payload: Record<string, unknown>): Promise<Response> =>
        request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify(payload),
          signal: req.signal
        })

      let res = await post(body)
      // 兼容层不认某参数时按报错逐个剔除重试（reasoning_effort 优先，其次 tool_choice），最多两轮
      const droppable: string[] = wantsEffort ? ['reasoning_effort', 'tool_choice'] : ['tool_choice']
      for (let guard = 0; guard < 2 && !res.ok && res.status === 400; guard++) {
        const text = await res.text()
        if (!isUnsupportedParamError(text)) throw classifyHttp(res.status, text)
        const param = droppable.find((p) => p in body)
        if (!param) throw classifyHttp(res.status, text)
        delete body[param]
        droppable.splice(droppable.indexOf(param), 1)
        log?.('provider.param_skipped', { model: req.model, param })
        res = await post(body)
      }

      await ensureOk(res)

      let text = ''
      let reasoning = ''
      let finish: string | null = null
      let usage: Usage | undefined
      const calls = new Map<number, ToolCallAcc>()

      for await (const payload of sseData(res, { signal: req.signal })) {
        if (payload === '[DONE]') break
        let json: Record<string, unknown>
        try {
          json = JSON.parse(payload) as Record<string, unknown>
        } catch {
          continue
        }

        const error = json.error as { message?: string; type?: string } | undefined
        if (error) throw new AgentFailure('bad_response', `模型服务错误：${error.message ?? JSON.stringify(error)}`)

        const rawUsage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | null | undefined
        if (rawUsage) usage = { input: rawUsage.prompt_tokens ?? 0, output: rawUsage.completion_tokens ?? 0 }

        const choices = json.choices as
          | {
              delta?: {
                content?: string | null
                reasoning_content?: string | null
                tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
              }
              finish_reason?: string | null
            }[]
          | undefined
        const choice = choices?.[0]
        if (!choice) continue

        const delta = choice.delta
        // 推理模型先吐 reasoning_content；只用来给界面反馈"在思考"，不进历史
        if (delta?.reasoning_content) {
          reasoning += delta.reasoning_content
          req.onThinkingDelta?.(delta.reasoning_content)
        }

        if (delta?.content) {
          text += delta.content
          req.onTextDelta(delta.content)
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index ?? 0
            const acc = calls.get(index) ?? { id: '', name: '', args: '' }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
            calls.set(index, acc)
          }
        }

        if (choice.finish_reason) finish = choice.finish_reason
      }

      const blocks: Block[] = []
      if (text) blocks.push({ type: 'text', text })
      for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        if (!call.name) continue
        blocks.push({
          type: 'tool_use',
          id: call.id || `call_${index}_${Date.now().toString(36)}`,
          name: call.name,
          input: safeJsonParse(call.args)
        })
      }

      const hasTools = blocks.some((b) => b.type === 'tool_use')
      if (!blocks.length) {
        // 区分"真的什么都没返回"和"只思考没落笔"，后者基本是 max_tokens 被思考吃完了
        if (reasoning) {
          throw new AgentFailure(
            'bad_response',
            finish === 'length'
              ? `模型把输出额度都用在了思考上，只返回了思维链而没有正文（输出上限 ${req.maxTokens || '服务商默认'} tokens）。`
              : '模型只返回了思维链，没有正文也没有工具调用。',
            { code: finish === 'length' ? 'reasoning_budget' : undefined }
          )
        }
        throw new AgentFailure('bad_response', '模型返回了空内容（没有文本也没有工具调用）')
      }

      return { blocks, stopReason: mapFinish(finish, hasTools), usage }
    }
  }
}
