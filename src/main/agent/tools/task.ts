import type { SubagentType } from '@shared/types'
import type { AgentTool, ToolContext, ToolResult } from './types'
import { asString, ToolError } from './util'

/** 子任务汇报太长会撑爆父会话的上下文，给个上限 */
const RESULT_MAX_CHARS = 30_000

const TYPES: SubagentType[] = ['general', 'explore', 'plan']

/**
 * task：派生一个子智能体独立完成子任务。
 *
 * 适用场景：探索性的大量读文件（调研目录结构、找实现）、与主线无关的独立验证
 * （跑测试并汇总失败项）。子智能体有独立的消息历史，看不到主对话；完成后
 * 以一段文本汇报返回。子智能体没有 task 工具，不能再嵌套派生。
 *
 * 类型决定能力边界：
 * - general：内置工具（除 task），可改文件、跑命令
 * - explore：只读查询（read/repomind/fetch/ask），没有 shell 和写入工具
 * - plan：同 explore 的工具集，产出实施计划而不是执行
 */
export const taskTool: AgentTool = {
  spec: {
    name: 'task',
    description:
      'Spawn a sub-agent to complete an independent sub-task. ' +
      'The sub-agent has its own conversation history (it cannot see this conversation) ' +
      'and reports its findings as text when done. ' +
      'Types: "general" has built-in tools (except task) and may modify files or run shell commands; ' +
      '"explore" uses read/repomind/fetch/ask for read-only research, without shell or write tools; ' +
      '"plan" is read-only and produces an implementation plan instead of executing. ' +
      'Use it for self-contained work that would otherwise flood the main thread with intermediate output. ' +
      'Multiple task calls in one turn run in parallel — when spawning several "general" sub-agents, make sure they do not write to the same files.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Complete self-contained description of the sub-task and what to report back' },
        label: { type: 'string', description: 'Short label (a few words) shown in the UI while running' },
        type: {
          type: 'string',
          enum: TYPES,
          description: 'Sub-agent type. Default "general". Use "explore" for read-only research.'
        }
      },
      required: ['prompt', 'label'],
      additionalProperties: false
    }
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.spawnSubAgent) {
      throw new ToolError('当前环境不支持子智能体（缺少执行器）')
    }
    const prompt = asString(input, 'prompt', { required: true }).trim()
    const label = asString(input, 'label', { required: true }).trim().slice(0, 40) || '子任务'
    const rawType = asString(input, 'type', { fallback: 'general' })
    const type: SubagentType = (TYPES as string[]).includes(rawType) ? (rawType as SubagentType) : 'general'
    if (!prompt) throw new ToolError('子任务描述不能为空')
    if (ctx.signal.aborted) return { content: '已中止', isError: true }

    ctx.log('tool.task_spawn', { label, type, promptChars: prompt.length })
    const result = await ctx.spawnSubAgent(prompt, label, ctx.callId ?? `task_${Date.now().toString(36)}`, type)

    const clipped =
      result.content.length > RESULT_MAX_CHARS
        ? `${result.content.slice(0, RESULT_MAX_CHARS)}\n…（子任务汇报过长已截断）`
        : result.content
    return { ...result, content: clipped }
  }
}
