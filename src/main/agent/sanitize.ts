import type { Message } from '@shared/types'

/**
 * 保证 assistant 的每个 tool_use 都有对应的 tool 结果。
 *
 * 为什么必须做：会话是一棵树，用户可能从"带工具调用的 assistant 消息"处分叉，
 * 于是这条路径上 tool_use 后面直接跟了一条新的 user 消息。OpenAI 与 Anthropic
 * 都会因此拒绝请求（tool_call 必须被 tool_result 应答）。
 * 这里补一条明确的"未执行"结果，既修正结构，也让模型知道发生了什么。
 */
export function sanitizeToolPairing(messages: Message[]): Message[] {
  const out: Message[] = []
  let pending: { id: string; name: string }[] = []

  const flush = (): void => {
    for (const p of pending) {
      out.push({
        role: 'tool',
        id: `synthetic_${p.id}`,
        ts: Date.now(),
        toolCallId: p.id,
        name: p.name,
        content: '（该工具调用未执行：会话在此处切换了分支）',
        isError: true
      })
    }
    pending = []
  }

  for (const m of messages) {
    if (m.role === 'tool') {
      if (!pending.length) continue // 孤儿结果，丢弃
      const idx = pending.findIndex((p) => p.id === m.toolCallId)
      if (idx < 0) continue
      pending.splice(idx, 1)
      out.push(m)
      continue
    }

    if (pending.length) flush()
    out.push(m)

    if (m.role === 'assistant') {
      pending = m.blocks
        .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name }))
    }
  }

  if (pending.length) flush()
  return out
}
