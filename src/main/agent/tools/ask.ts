import { randomUUID } from 'node:crypto'
import type { AgentTool, ToolContext, ToolResult } from './types'
import { asString, ToolError } from './util'

/**
 * ask：模型反问用户的结构化通道（ZCode AskUserQuestion 式）。
 * 模型给出问题与 2–4 个候选，渲染层弹卡片；用户点选后答案作为工具结果回填。
 * 等待期间可被中止（abort signal），超时 10 分钟。
 */

const TIMEOUT_MS = 10 * 60_000
const MAX_OPTIONS = 4

interface PendingAsk {
  resolve: (answer: string) => void
  reject: (err: Error) => void
}

/** callId → 等待中的提问；渲染层经 IPC ask:answer 回填 */
const pending = new Map<string, PendingAsk>()

/** 渲染层回填答案（choice = 选项下标；-1 表示"其他"，用 text） */
export function answerAsk(callId: string, choice: number, text: string): boolean {
  const p = pending.get(callId)
  if (!p) return false
  const trimmed = text.trim()
  if (choice >= 0) p.resolve(`用户选择了：${trimmed}`)
  else p.resolve(trimmed ? `用户补充输入：${trimmed}` : '用户没有给出有效回答。')
  return true
}

/** 渲染层登记提问投递器（ipc.ts 注册时绑定，把事件发到窗口） */
let deliver: ((payload: { sessionId: string; callId: string; question: string; options: string[] }) => void) | null = null
let deliverClosed: ((payload: { sessionId: string; callId: string }) => void) | null = null

export function bindAskDelivery(fn: typeof deliver): void {
  deliver = fn
}

export function bindAskCloseDelivery(fn: typeof deliverClosed): void {
  deliverClosed = fn
}

export const askTool: AgentTool = {
  spec: {
    name: 'ask',
    description:
      'Ask the user a structured question with 2-4 candidate options when the request is ambiguous ' +
      'or a decision is genuinely theirs (approach choice, confirm-before-irreversible, scope). ' +
      'The user picks one or types their own answer; the reply arrives as the tool result. ' +
      'Do NOT use it for questions you can resolve yourself from the code or context.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The complete question, one or two sentences.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '2-4 concise candidate answers (each a short phrase).'
        }
      },
      required: ['question', 'options'],
      additionalProperties: false
    }
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const question = asString(input, 'question', { required: true }).trim().slice(0, 500)
    const rawOptions = Array.isArray(input.options) ? input.options : []
    const options = rawOptions
      .map((o) => String(o ?? '').trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, MAX_OPTIONS)
    if (!question) throw new ToolError('question 不能为空')
    if (options.length < 2) throw new ToolError('至少给出 2 个候选选项')

    if (!deliver) throw new ToolError('提问通道不可用（界面未就绪）')
    if (ctx.signal.aborted) throw new ToolError('用户中止了任务，提问已取消')

    // UI 请求独立编号；不同会话的模型可能返回相同的工具 callId。
    const callId = `ask_${randomUUID()}`
    const sessionId = ctx.sessionId ?? ''
    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.get(callId)?.reject(new ToolError('提问超时未回答（10 分钟）'))
      }, TIMEOUT_MS)
      const cleanup = (): boolean => {
        if (!pending.delete(callId)) return false
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        try {
          deliverClosed?.({ sessionId, callId })
        } catch (err) {
          ctx.log('tool.ask_close_failed', { callId, message: String(err) })
        }
        return true
      }
      const onAbort = (): void => {
        // 走 pending 里的包装 reject：同时清 timer、摘掉挂起项（否则中止后泄漏到超时才回收）
        pending.get(callId)?.reject(new ToolError('用户中止了任务，提问已取消'))
      }
      pending.set(callId, {
        resolve: (answer) => {
          if (cleanup()) resolve(answer)
        },
        reject: (err) => {
          if (cleanup()) reject(err)
        }
      })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    })

    try {
      deliver({ sessionId, callId, question, options })
    } catch (err) {
      pending.get(callId)?.reject(err instanceof Error ? err : new Error(String(err)))
    }
    ctx.log('tool.ask', { callId, options: options.length })
    const answer = await promise
    return { content: answer, isError: false }
  }
}
