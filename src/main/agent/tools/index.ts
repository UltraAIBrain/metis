import type { ToolSpec } from '@shared/types'
import type { AgentTool, ToolContext, ToolResult } from './types'
import { readTool } from './read'
import { writeTool } from './write'
import { editTool } from './edit'
import { bashTool } from './bash'
import { taskTool } from './task'
import { memoryTool } from './memory'
import { repomindTool } from './repomind'
import { skillsTool } from './skills'
import { fetchTool } from './fetch'
import { askTool } from './ask'
import { ToolError } from './util'
import { pluginHost } from '../../plugins'
import { logger } from '../../logger'

/**
 * pi 的内置能力：四个文件/命令工具 + task（子智能体）+ 记忆/技能 + 仓库图谱 + 网页阅读。
 * 刻意不再加 grep/glob/ls 之类的封装：bash 已经能覆盖，工具越少模型越不容易乱用。
 * 额外能力通过插件注册，见 ../../plugins。
 */
export const BUILTIN_TOOLS: AgentTool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  taskTool,
  memoryTool,
  skillsTool,
  repomindTool,
  fetchTool,
  askTool
]

/** task 只给主循环用：子智能体不能再派生子智能体，防止无限递归 */
const SUB_EXCLUDE = new Set(['task'])

const MEMORY_TOOL = 'memory'
const SKILLS_TOOL = 'skills'

/** 记忆与技能由主 agent 维护：并行子任务同时写会有交错风险 */
const CURATED_TOOLS = [MEMORY_TOOL, SKILLS_TOOL]

/** 各子类型的额外排除：explore/plan 只读，物理上不能改文件 */
const SUB_TYPE_EXCLUDE: Record<string, Set<string>> = {
  general: new Set<string>(),
  explore: new Set(['write', 'edit', ...CURATED_TOOLS]),
  plan: new Set(['write', 'edit', ...CURATED_TOOLS])
}

const BUILTIN_NAMES = new Set(BUILTIN_TOOLS.map((t) => t.spec.name))

/** 插件工具与内置工具重名时内置优先，插件那条被忽略 */
function extraTools(): AgentTool[] {
  const out: AgentTool[] = []
  for (const tool of pluginHost.tools()) {
    if (BUILTIN_NAMES.has(tool.spec.name)) {
      logger.warn('plugin.tool_conflict', { name: tool.spec.name })
      continue
    }
    out.push(tool)
  }
  return out
}

export function toolSpecs(opts: { forSubAgent?: boolean; subagentType?: string } = {}): ToolSpec[] {
  // 子智能体只用内置工具：插件工具没有只读声明，混进来会击穿 explore/plan 的只读承诺
  const all = opts.forSubAgent ? [...BUILTIN_TOOLS] : [...BUILTIN_TOOLS, ...extraTools()]
  if (!opts.forSubAgent) return all.map((t) => t.spec)
  const excluded = new Set([...SUB_EXCLUDE, ...(SUB_TYPE_EXCLUDE[opts.subagentType ?? 'general'] ?? new Set())])
  return all.filter((t) => !excluded.has(t.spec.name)).map((t) => t.spec)
}

export type { AgentTool, ToolContext, ToolResult }
export { ToolError }

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  // 插件 PreToolUse 钩子链：deny 拦截、modify 改参（审计/风控类插件挂这里，fail-open）
  const gate = pluginHost.runBeforeTool(name, input)
  if (gate.denied) {
    ctx.log('tool.hook_denied', { tool: name, reason: gate.denied })
    return { content: `Error: 本次 ${name} 调用被插件拦截：${gate.denied}`, isError: true }
  }
  const effectiveInput = gate.input
  const tool = BUILTIN_TOOLS.find((t) => t.spec.name === name) ?? extraTools().find((t) => t.spec.name === name)
  if (!tool) {
    const names = [...BUILTIN_TOOLS.map((t) => t.spec.name), ...extraTools().map((t) => t.spec.name)]
    return { content: `Error: 未知工具 ${name}。可用工具：${names.join(', ')}`, isError: true }
  }
  try {
    return await tool.run(effectiveInput, ctx)
  } catch (err) {
    if (err instanceof ToolError) return { content: `Error: ${err.message}`, isError: true }
    const msg = err instanceof Error ? err.message : String(err)
    ctx.log('tool.crash', { tool: name, message: msg })
    return { content: `Error: 工具 ${name} 执行异常：${msg}`, isError: true }
  }
}
