import type { AgentError } from '@shared/types'

export type ErrorKind = AgentError['kind']

/** provider / 运行时错误，携带可分类信息用于 UI 提示与重试决策。 */
export class AgentFailure extends Error {
  readonly kind: ErrorKind
  readonly status?: number
  readonly retryable: boolean
  /** 机器可读的细分原因，例如 reasoning_budget（思考把输出额度吃完了） */
  readonly code?: string

  constructor(
    kind: ErrorKind,
    message: string,
    opts: { status?: number; retryable?: boolean; code?: string } = {}
  ) {
    super(message)
    this.name = 'AgentFailure'
    this.kind = kind
    this.status = opts.status
    this.retryable = opts.retryable ?? (kind === 'rate_limit' || kind === 'network' || kind === 'server')
    this.code = opts.code
  }

  toAgentError(): AgentError {
    return { kind: this.kind, message: this.message, retryable: this.retryable, status: this.status }
  }
}

const HINTS: Record<ErrorKind, string> = {
  auth: 'API Key 无效或无权限，请在设置中重新填写。',
  rate_limit: '请求频率或额度受限，稍后重试或切换模型。',
  network: '无法连接模型服务，检查网络或 base URL。',
  context: '上下文超出模型窗口，请新建会话或清理历史。',
  server: '模型服务返回异常，已自动重试仍失败。',
  bad_response: '模型返回内容无法解析为有效响应。',
  config: '配置不完整，请先在设置中补全。',
  unknown: '发生未知错误，详见日志。'
}

export function describeFailure(err: unknown): AgentError {
  if (err instanceof AgentFailure) return err.toAgentError()
  const msg = err instanceof Error ? err.message : String(err)
  return { kind: 'unknown', message: msg, retryable: false }
}

export function failureHint(kind: ErrorKind): string {
  return HINTS[kind]
}

/** 从错误响应体里挑出人能读的那一句话，别把整段 JSON 甩给用户。 */
function extractMessage(body: string): string {
  const raw = body.trim()
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const err = parsed.error
    if (typeof err === 'string' && err.trim()) return err.trim()
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>).message
      if (typeof m === 'string' && m.trim()) return m.trim()
    }
    for (const key of ['message', 'detail', 'msg'] as const) {
      const v = parsed[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  } catch {
    /* 不是 JSON，按原文截断 */
  }
  return raw.slice(0, 400)
}

/** 根据 HTTP 状态映射错误类型。 */
export function classifyHttp(status: number, body: string): AgentFailure {
  const detail = extractMessage(body)
  const snippet = detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`
  if (status === 401 || status === 403) return new AgentFailure('auth', snippet, { status })
  if (status === 429) return new AgentFailure('rate_limit', snippet, { status })
  if (status === 400 || status === 413 || status === 422) {
    const contextish = /context|too long|maximum|token limit|exceed/i.test(detail)
    return new AgentFailure(contextish ? 'context' : 'bad_response', snippet, { status })
  }
  if (status >= 500) return new AgentFailure('server', snippet, { status })
  return new AgentFailure('bad_response', snippet, { status })
}
