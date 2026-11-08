import type { Block, Message, ProviderId, StopReason, ThinkingEffort, ToolSpec, Usage } from '@shared/types'

export type ProviderLog = (event: string, data?: unknown) => void

export interface StreamRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  model: string
  temperature: number
  /** 本次请求的输出上限；0 / 未设为沿用服务商默认 */
  maxTokens?: number
  /** 思考强度；模型不支持时 provider 会自动退回不传 */
  thinking: ThinkingEffort
  signal: AbortSignal
  onTextDelta: (text: string) => void
  /** 推理模型的思维链增量；只用于界面上"思考中"的反馈，不进历史 */
  onThinkingDelta?: (text: string) => void
}

export interface StreamResult {
  blocks: Block[]
  stopReason: StopReason
  usage?: Usage
}

export interface Provider {
  id: ProviderId
  stream(req: StreamRequest): Promise<StreamResult>
}

/** 跳过空的 assistant 消息，否则部分 provider 会直接 400。 */
export function isRenderable(m: Message): boolean {
  if (m.role !== 'assistant') return true
  return m.blocks.length > 0
}

export function textOf(blocks: Block[]): string {
  return blocks
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

/**
 * 只在看起来支持思考强度的模型上带参数。
 * 白名单式匹配，宁可漏传也不要给非推理模型塞一个它会 400 的字段。
 */
export function supportsEffort(model: string): boolean {
  return /(glm[-_.]?(4\.[5-9]|[5-9])|o[1-9][-_a-z]*$|gpt[-_.]?[5-9]|deepseek[-_.]?(r1|v[3-9])|qwq|thinking|reasoner)/i.test(
    model
  )
}

/** Claude 5.x 起用 output_config.effort 控制思考深度 */
export function supportsAnthropicEffort(model: string): boolean {
  return /claude-[a-z0-9.]+-[5-9]/i.test(model)
}

/**
 * 服务端明确抱怨"参数不认识"——此时才应当去掉思考参数重试。
 * 刻意收紧：`not support` / `invalid.*param` 这类宽泛措辞会把真实错误
 * （例如模型不支持该能力）误判成参数问题，盲目删参数再多打一次请求。
 */
export function isUnsupportedParamError(text: string): boolean {
  return /reasoning[_\s-]?effort|output_config|unsupported (parameter|value)|unknown (field|parameter)|unrecognized/i.test(
    text
  )
}
