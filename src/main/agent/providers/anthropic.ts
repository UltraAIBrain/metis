import type { Block, Message, StopReason, Usage } from '@shared/types'
import { AgentFailure, classifyHttp } from '../errors'
import { attachmentBase64, attachmentText } from '../../attachments'
import { ensureOk, request, safeJsonParse, sseData } from './sse'
import type { Provider, ProviderLog, StreamRequest, StreamResult } from './types'
import { isRenderable, isUnsupportedParamError, supportsAnthropicEffort, textOf } from './types'

type ABlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface ATurn {
  role: 'user' | 'assistant'
  content: ABlock[]
}

const MAX_TOKENS = 8192

async function convert(messages: Message[]): Promise<ATurn[]> {
  const turns: ATurn[] = []

  const push = (role: 'user' | 'assistant', blocks: ABlock[]): void => {
    if (!blocks.length) return
    const last = turns[turns.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else turns.push({ role, content: blocks })
  }

  for (const m of messages) {
    if (!isRenderable(m)) continue

    if (m.role === 'user') {
      const blocks: ABlock[] = []
      if (m.text) blocks.push({ type: 'text', text: m.text })
      for (const a of m.attachments ?? []) {
        if (a.kind === 'image') {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: attachmentBase64(a) } })
        } else {
          blocks.push({ type: 'text', text: `[附件 ${a.name}]\n\`\`\`\n${attachmentText(a)}\n\`\`\`` })
        }
      }
      push('user', blocks)
      continue
    }

    if (m.role === 'assistant') {
      const blocks: ABlock[] = []
      const text = textOf(m.blocks)
      if (text) blocks.push({ type: 'text', text })
      for (const b of m.blocks) {
        if (b.type === 'tool_use') blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} })
      }
      push('assistant', blocks)
      continue
    }

    push('user', [
      {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content || '(empty)',
        is_error: m.isError || undefined
      }
    ])
  }

  // Anthropic 要求首条为 user；防御性处理异常的会话起点。
  while (turns.length && turns[0].role === 'assistant') turns.shift()
  if (!turns.length) turns.push({ role: 'user', content: [{ type: 'text', text: '(continue)' }] })
  return turns
}

function mapStop(reason: string | null | undefined, hasTools: boolean): StopReason {
  if (hasTools) return 'toolUse'
  if (reason === 'max_tokens') return 'maxTokens'
  return 'stop'
}

export function createAnthropicProvider(baseUrl: string, apiKey: string, log?: ProviderLog): Provider {
  const base = baseUrl.replace(/\/+$/, '')
  const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`

  return {
    id: 'anthropic',

    async stream(req: StreamRequest): Promise<StreamResult> {
      const body: Record<string, unknown> = {
        model: req.model,
        max_tokens: req.maxTokens && req.maxTokens > 0 ? req.maxTokens : MAX_TOKENS,
        temperature: req.temperature,
        system: req.system,
        stream: true,
        messages: await convert(req.messages),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters
        }))
      }

      // Claude 5.x 用 output_config.effort；老模型认不出来的话靠 400 兜底重试
      const wantsEffort = supportsAnthropicEffort(req.model)
      if (wantsEffort) body.output_config = { effort: req.thinking }

      const post = (payload: Record<string, unknown>): Promise<Response> =>
        request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify(payload),
          signal: req.signal
        })

      let res = await post(body)
      if (!res.ok && wantsEffort) {
        const detail = await res.text()
        if (res.status === 400 && isUnsupportedParamError(detail)) {
          log?.('provider.param_skipped', { model: req.model, param: 'output_config' })
          delete body.output_config
          res = await post(body)
        } else {
          throw classifyHttp(res.status, detail)
        }
      }

      await ensureOk(res)

      let text = ''
      let reasoning = ''
      let stop: string | null = null
      let usage: Usage | undefined
      const calls = new Map<number, { id: string; name: string; json: string }>()

      for await (const payload of sseData(res, { signal: req.signal })) {
        let evt: Record<string, unknown>
        try {
          evt = JSON.parse(payload) as Record<string, unknown>
        } catch {
          continue
        }

        switch (evt.type) {
          case 'message_start': {
            const u = (evt.message as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage
            if (u) usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 }
            break
          }
          case 'content_block_start': {
            const cb = evt.content_block as { type?: string; id?: string; name?: string; text?: string } | undefined
            if (cb?.type === 'tool_use') {
              calls.set(typeof evt.index === 'number' ? evt.index : 0, { id: cb.id ?? '', name: cb.name ?? '', json: '' })
            } else if (cb?.type === 'text' && cb.text) {
              text += cb.text
              req.onTextDelta(cb.text)
            }
            break
          }
          case 'content_block_delta': {
            const d = evt.delta as
              | { type?: string; text?: string; thinking?: string; partial_json?: string }
              | undefined
            if (d?.type === 'text_delta' && d.text) {
              text += d.text
              req.onTextDelta(d.text)
            } else if (d?.type === 'thinking_delta' && d.thinking) {
              // 扩展思考：只用于界面反馈，不进历史
              reasoning += d.thinking
              req.onThinkingDelta?.(d.thinking)
            } else if (d?.type === 'input_json_delta') {
              const acc = calls.get(typeof evt.index === 'number' ? evt.index : 0)
              if (acc) acc.json += d.partial_json ?? ''
            }
            break
          }
          case 'message_delta': {
            const dd = evt.delta as { stop_reason?: string } | undefined
            const uu = evt.usage as { output_tokens?: number } | undefined
            if (dd?.stop_reason) stop = dd.stop_reason
            if (uu?.output_tokens !== undefined) {
              if (usage) usage.output = uu.output_tokens
              else usage = { input: 0, output: uu.output_tokens }
            }
            break
          }
          case 'error': {
            const ee = evt.error as { message?: string; type?: string } | undefined
            const msg = ee?.message ?? '流式响应返回错误'
            const type = String(ee?.type ?? '')
            if (type.includes('overloaded') || type.includes('rate')) throw new AgentFailure('rate_limit', msg)
            if (type.includes('authentication')) throw new AgentFailure('auth', msg)
            throw new AgentFailure('server', msg)
          }
          default:
            break
        }
      }

      const blocks: Block[] = []
      if (text) blocks.push({ type: 'text', text })
      for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
        if (!call.name) continue
        blocks.push({
          type: 'tool_use',
          id: call.id || `toolu_${index}_${Date.now().toString(36)}`,
          name: call.name,
          input: safeJsonParse(call.json)
        })
      }

      if (!blocks.length) {
        if (reasoning) {
          throw new AgentFailure(
            'bad_response',
            stop === 'max_tokens'
              ? '模型把输出额度都用在了思考上，只返回了思维链而没有正文。'
              : '模型只返回了思维链，没有正文也没有工具调用。',
            { code: stop === 'max_tokens' ? 'reasoning_budget' : undefined }
          )
        }
        throw new AgentFailure('bad_response', '模型返回了空内容（没有文本也没有工具调用）')
      }
      const hasTools = blocks.some((b) => b.type === 'tool_use')
      return { blocks, stopReason: mapStop(stop, hasTools), usage }
    }
  }
}
