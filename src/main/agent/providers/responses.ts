import type { Block, Message, StopReason, ToolSpec, Usage } from '@shared/types'
import { AgentFailure, classifyHttp } from '../errors'
import { attachmentBase64, attachmentText } from '../../attachments'
import { ensureOk, request, safeJsonParse, sseData } from './sse'
import type { Provider, ProviderLog, StreamRequest, StreamResult } from './types'
import { isRenderable, isUnsupportedParamError, supportsEffort, textOf } from './types'

/**
 * OpenAI Responses API（ChatGPT 登录后的 codex 后端）。
 * 与 chat/completions 的差异：
 * - 消息序列变成 input items（user/assistant 角色 + function_call / function_call_output 独立条目）
 * - 工具定义扁平化（name/description/parameters 直接在顶层）
 * - 流式事件按 type 字段分发：output_text.delta、function_call_arguments.delta、response.completed 等
 * - 思考强度走 reasoning.effort（low/medium/high；max 映射为 high）
 */

type ResponsesItem = Record<string, unknown>

async function buildItems(messages: Message[]): Promise<ResponsesItem[]> {
  const items: ResponsesItem[] = []

  for (const m of messages) {
    if (!isRenderable(m)) continue

    if (m.role === 'user') {
      if (m.attachments?.length) {
        const content: Record<string, unknown>[] = []
        if (m.text) content.push({ type: 'input_text', text: m.text })
        for (const a of m.attachments) {
          if (a.kind === 'image') {
            content.push({ type: 'input_image', image_url: `data:${a.mime};base64,${attachmentBase64(a)}` })
          } else {
            content.push({ type: 'input_text', text: `[附件 ${a.name}]\n\`\`\`\n${attachmentText(a)}\n\`\`\`` })
          }
        }
        items.push({ role: 'user', content })
      } else {
        items.push({ role: 'user', content: [{ type: 'input_text', text: m.text }] })
      }
      continue
    }

    if (m.role === 'assistant') {
      const text = textOf(m.blocks)
      if (text) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const b of m.blocks) {
        if (b.type !== 'tool_use') continue
        items.push({
          type: 'function_call',
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {})
        })
      }
      continue
    }

    items.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content })
  }

  return items
}

interface CallAcc {
  callId: string
  name: string
  args: string
}

export function createResponsesProvider(baseUrl: string, apiKey: string, log?: ProviderLog): Provider {
  const url = `${baseUrl.replace(/\/+$/, '')}/responses`

  return {
    id: 'responses',

    async stream(req: StreamRequest): Promise<StreamResult> {
      const wantsEffort = supportsEffort(req.model)
      const body: Record<string, unknown> = {
        model: req.model,
        stream: true,
        instructions: req.system,
        input: await buildItems(req.messages),
        tools: req.tools.map((t: ToolSpec) => ({
          type: 'function',
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          strict: false
        })),
        tool_choice: 'auto'
      }
      if (!supportsEffort(req.model)) body.temperature = req.temperature
      if (req.maxTokens && req.maxTokens > 0) body.max_output_tokens = req.maxTokens
      // Responses API 的思考强度取 low/medium/high；max 映射为 high
      if (wantsEffort) body.reasoning = { effort: req.thinking === 'low' ? 'low' : 'high' }

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
      // 参数不认识时按 openai 适配器同款策略降级（reasoning 优先，其次 tool_choice）
      const droppable: string[] = wantsEffort ? ['reasoning', 'tool_choice'] : ['tool_choice']
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
      let finish: 'completed' | 'incomplete' | null = null
      let incompleteReason = ''
      let usage: Usage | undefined
      /** item_id → 调用累积（arguments 以流式 delta 拼接，done 事件带全量兜底） */
      const calls = new Map<string, CallAcc>()

      for await (const payload of sseData(res, { signal: req.signal })) {
        let json: Record<string, unknown>
        try {
          json = JSON.parse(payload) as Record<string, unknown>
        } catch {
          continue
        }

        const type = typeof json.type === 'string' ? json.type : ''

        if (type === 'error' || type === 'response.failed') {
          const errObj = (json.error ?? (json.response as Record<string, unknown> | undefined)?.error) as
            | { message?: string }
            | undefined
          throw new AgentFailure('bad_response', `模型服务错误：${errObj?.message ?? payload.slice(0, 200)}`)
        }

        if (type === 'response.output_text.delta' && typeof json.delta === 'string') {
          text += json.delta
          req.onTextDelta(json.delta)
          continue
        }
        if (type === 'response.reasoning_summary_text.delta' && typeof json.delta === 'string') {
          reasoning += json.delta
          req.onThinkingDelta?.(json.delta)
          continue
        }
        if (type === 'response.output_item.added') {
          const item = json.item as Record<string, unknown> | undefined
          if (item?.type === 'function_call') {
            const itemId = String(item.id ?? '')
            calls.set(itemId, {
              callId: String(item.call_id ?? itemId),
              name: String(item.name ?? ''),
              args: ''
            })
          }
          continue
        }
        if (type === 'response.function_call_arguments.delta') {
          const itemId = String(json.item_id ?? '')
          const acc = calls.get(itemId)
          if (acc && typeof json.delta === 'string') acc.args += json.delta
          continue
        }
        if (type === 'response.output_item.done') {
          const item = json.item as Record<string, unknown> | undefined
          if (item?.type === 'function_call') {
            const itemId = String(item.id ?? '')
            const acc = calls.get(itemId) ?? { callId: String(item.call_id ?? itemId), name: '', args: '' }
            if (item.call_id) acc.callId = String(item.call_id)
            if (item.name) acc.name = String(item.name)
            if (typeof item.arguments === 'string' && item.arguments) acc.args = item.arguments
            calls.set(itemId, acc)
          }
          continue
        }
        if (type === 'response.completed' || type === 'response.incomplete') {
          finish = type === 'response.completed' ? 'completed' : 'incomplete'
          const response = json.response as Record<string, unknown> | undefined
          const rawUsage = response?.usage as { input_tokens?: number; output_tokens?: number } | undefined
          if (rawUsage) usage = { input: rawUsage.input_tokens ?? 0, output: rawUsage.output_tokens ?? 0 }
          const details = response?.incomplete_details as { reason?: string } | undefined
          if (details?.reason) incompleteReason = details.reason
          continue
        }
      }

      const blocks: Block[] = []
      if (text) blocks.push({ type: 'text', text })
      for (const acc of calls.values()) {
        if (!acc.name) continue
        blocks.push({ type: 'tool_use', id: acc.callId, name: acc.name, input: safeJsonParse(acc.args) })
      }

      const hasTools = blocks.some((b) => b.type === 'tool_use')
      if (!blocks.length) {
        if (reasoning) {
          throw new AgentFailure(
            'bad_response',
            finish === 'incomplete'
              ? `模型把输出额度都用在了思考上，只返回了思维链而没有正文（输出上限 ${req.maxTokens || '服务商默认'} tokens）。`
              : '模型只返回了思维链，没有正文也没有工具调用。',
            { code: finish === 'incomplete' ? 'reasoning_budget' : undefined }
          )
        }
        throw new AgentFailure('bad_response', '模型返回了空内容（没有文本也没有工具调用）')
      }

      const stopReason: StopReason = hasTools
        ? 'toolUse'
        : incompleteReason.includes('max_output')
          ? 'maxTokens'
          : 'stop'
      return { blocks, stopReason, usage }
    }
  }
}
