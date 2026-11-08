import type { ShellKind, SubagentType, ToolMeta, ToolSpec } from '@shared/types'

export interface ToolContext {
  /** 当前会话（项目）的工作目录：所有相对路径以此为根，越界会被拒绝 */
  workspace: string
  shell: ShellKind
  signal: AbortSignal
  log: (event: string, data?: unknown) => void
  /** 本次工具调用所在会话（runner 构造 ctx 时注入；插件工具的 ctx 没有） */
  sessionId?: string
  /** 本次工具调用在父会话里的 id（runner 构造 ctx 时注入；插件工具的 ctx 没有） */
  callId?: string
  /**
   * 派生一个子智能体执行独立子任务（只有 runner 构造的 ctx 会提供）。
   * 子智能体有独立的消息历史，完成后以文本汇报作为工具结果返回。
   * type 决定它的工具集（explore/plan 为只读）与系统提示词；
   * taskCallId 用于把子任务进度事件关联回界面上的这张 task 卡片。
   */
  spawnSubAgent?: (prompt: string, label: string, taskCallId: string, type: SubagentType) => Promise<ToolResult>
}

export interface ToolResult {
  content: string
  isError: boolean
  meta?: ToolMeta
}

export interface AgentTool {
  spec: ToolSpec
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}
