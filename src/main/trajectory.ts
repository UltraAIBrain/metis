import { existsSync, readFileSync } from 'node:fs'
import type { Message, SubagentRun, ToolMessage, Trajectory, TrajectoryStep, TrajectoryTurn } from '@shared/types'
import { subagentsFile, type SessionStore } from './agent/session'

/**
 * 把会话历史聚合成"运行轨迹"（仿 agent harness 的 trajectory）：
 * 按用户消息切段，每段里收集全部模型响应与工具往返，统计步数 / token / 耗时。
 *
 * 与原始 JSONL 的区别：JSONL 是树形存储（含分支），轨迹是**当前分支上的线性回放**，
 * 每个回合自带统计，方便导出、对比与事后分析。
 */

function userTextOf(m: Extract<Message, { role: 'user' }>): string {
  const names = (m.attachments ?? []).map((a) => `[附件 ${a.name}]`)
  return [m.text, ...names].filter(Boolean).join('\n')
}

/** 读取子任务过程记录（每个 task 完成时追加一行）；损坏的行跳过；只保留当前分支上的调用 */
function loadSubProcesses(sessionId: string, branchCallIds: Set<string>): Record<string, SubagentRun> | undefined {
  const file = subagentsFile(sessionId)
  if (!existsSync(file)) return undefined
  const out: Record<string, SubagentRun> = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const run = JSON.parse(trimmed) as SubagentRun
      // 分叉的会话里 .subagents.jsonl 记录了所有分支的子任务，只关联当前分支发起的
      if (run.taskCallId && branchCallIds.has(run.taskCallId)) out[run.taskCallId] = run
    } catch {
      /* 单行损坏不影响其余 */
    }
  }
  return Object.keys(out).length ? out : undefined
}

export function buildTrajectory(store: SessionStore, sessionId: string): Trajectory {
  const view = store.view(sessionId)
  const messages = view.messages

  const turns: TrajectoryTurn[] = []
  let current: TrajectoryTurn | null = null
  /** toolCallId → 该调用的结果消息（结果永远跟在发起它的 assistant 之后） */
  const toolResults = new Map<string, ToolMessage>()
  /** 当前分支上发起过的 task 调用（用于过滤子过程记录） */
  const branchTaskCallIds = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool') toolResults.set(m.toolCallId, m)
    if (m.role === 'assistant') {
      for (const b of m.blocks) {
        if (b.type === 'tool_use' && b.name === 'task') branchTaskCallIds.add(b.id)
      }
    }
  }

  for (const m of messages) {
    if (m.role === 'user') {
      if (current) turns.push(current)
      current = {
        userId: m.id,
        userText: userTextOf(m),
        startedAt: m.ts,
        endedAt: m.ts,
        steps: 0,
        responses: [],
        inputTokens: 0,
        outputTokens: 0
      }
      continue
    }

    if (m.role === 'assistant' && current) {
      const text = m.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')

      const toolCalls: TrajectoryStep[] = m.blocks
        .filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
        .map((call) => {
          const result = toolResults.get(call.id)
          return {
            toolCallId: call.id,
            name: call.name,
            input: call.input,
            content: result?.content ?? '（未执行）',
            isError: result?.isError ?? true,
            meta: result?.meta,
            durationMs: result?.meta?.kind === 'bash' ? result.meta.durationMs : undefined
          }
        })

      current.responses.push({
        assistantId: m.id,
        model: m.model,
        text,
        toolCalls,
        usage: m.usage,
        stopReason: m.stopReason,
        error: m.error,
        // 两个 assistant 消息之间没有可靠间隔基准，用相邻消息时间戳估算
        durationMs: Math.max(0, m.ts - current.startedAt)
      })
      current.steps++
      current.endedAt = m.ts
      if (m.usage) {
        current.inputTokens += m.usage.input
        current.outputTokens += m.usage.output
      }
    }
  }
  if (current) turns.push(current)

  const totals = turns.reduce(
    (acc, t) => ({
      turns: acc.turns + 1,
      steps: acc.steps + t.steps,
      inputTokens: acc.inputTokens + t.inputTokens,
      outputTokens: acc.outputTokens + t.outputTokens,
      durationMs: acc.durationMs + Math.max(0, t.endedAt - t.startedAt)
    }),
    { turns: 0, steps: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 }
  )
  // 总耗时 = 各回合模型活动时间之和（回合之间的用户停顿不计入"运行耗时"）
  const lastModel =
    [...messages].reverse().find((m): m is Extract<Message, { role: 'assistant' }> => m.role === 'assistant')?.model ??
    ''

  return {
    sessionId,
    title: view.title,
    cwd: view.cwd,
    // 会话没绑定模型时回落到实际用过的模型名，导出不再为空
    model: view.model ?? lastModel,
    createdAt: view.createdAt,
    exportedAt: Date.now(),
    turns,
    totals,
    subProcesses: loadSubProcesses(sessionId, branchTaskCallIds)
  }
}
