import type { AgentError } from '@shared/types'

export type ErrorKind = AgentError['kind']

/** provider / 运行时错误，携带可分类信息用于 UI 提示与重试决策。 */
export class AgentFailure extends Error {
  readonly kind: ErrorKind
  readonly status?: number
  readonly retryable: boolean
  /** 机器可读的细分原因，例如 reasoning_budget（思考把输出额度吃完了）、dns（解析失败） */
  readonly code?: string
  /** 服务端要求的等待时长（Retry-After），仅限流/服务端错误会带 */
  readonly retryAfterMs?: number

  constructor(
    kind: ErrorKind,
    message: string,
    opts: { status?: number; retryable?: boolean; code?: string; retryAfterMs?: number } = {}
  ) {
    super(message)
    this.name = 'AgentFailure'
    this.kind = kind
    this.status = opts.status
    this.retryable = opts.retryable ?? (kind === 'rate_limit' || kind === 'network' || kind === 'server')
    this.code = opts.code
    this.retryAfterMs = opts.retryAfterMs
  }

  toAgentError(): AgentError {
    return { kind: this.kind, message: this.message, retryable: this.retryable, status: this.status }
  }
}

const HINTS: Record<ErrorKind, string> = {
  auth: 'API Key 无效或无权限，请在设置中重新填写。',
  rate_limit: '请求频率或额度受限，稍后重试或切换模型。',
  network: '已按退避重试仍未连上：检查网络与代理（代理需要 TUN/增强模式，Node 不读系统代理），或确认 base URL。',
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

/* ------------------------------------------------------------------ */
/* 传输层：把 undici 的 "fetch failed" 拆开                              */
/* ------------------------------------------------------------------ */

/**
 * undici 的 fetch 只抛 `TypeError('fetch failed')`，真正原因挂在 `cause` 上；
 * 而 Node 20+ 的 autoSelectFamily 会把多个地址的失败包成 `AggregateError.errors`。
 * 不把这些拆出来，DNS 失败 / 端口不通 / 超时 / 证书错误在界面上是同一句话。
 */
function flattenCause(err: unknown, depth = 0): { code: string; message: string }[] {
  if (!err || depth > 4) return []
  const e = err as { code?: unknown; message?: unknown; errors?: unknown; cause?: unknown }
  const out: { code: string; message: string }[] = []
  if (typeof e.code === 'string' || typeof e.message === 'string') {
    out.push({
      code: typeof e.code === 'string' ? e.code : '',
      message: typeof e.message === 'string' ? e.message : String(err)
    })
  }
  if (Array.isArray(e.errors)) for (const inner of e.errors) out.push(...flattenCause(inner, depth + 1))
  if (e.cause) out.push(...flattenCause(e.cause, depth + 1))
  return out
}

interface NetRule {
  test: RegExp
  /** 机器可读的细分类型，同时写进 AgentFailure.code */
  kind: string
  /** 证书类错误重试也没用，其它传输错误可以退避重试 */
  retryable: boolean
  say: (host: string) => string
}

/** 顺序即优先级：证书类先判，避免被后面的通用规则抢走 */
const NET_RULES: NetRule[] = [
  {
    test: /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i,
    kind: 'tls',
    retryable: false,
    say: (h) => `无法校验 ${h} 的 TLS 证书：可能被公司网关或中间人代理拦截，也可能是根证书过期`
  },
  {
    test: /ENOTFOUND|EAI_AGAIN|EAI_FAIL/i,
    kind: 'dns',
    retryable: true,
    say: (h) => `解析不了域名 ${h}：网络可能已断开，或该地址需要走代理`
  },
  {
    test: /ECONNREFUSED/i,
    kind: 'refused',
    retryable: true,
    say: (h) => `连接 ${h} 被拒绝：base URL 端口不对，或本地代理 / 网关没在监听`
  },
  {
    // 注意 Node 的码是 ETIMEDOUT（E-TIME-DOUT），不含 "TIMEOUT" 子串，别只写 TIMEOUT
    test: /TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    kind: 'timeout',
    retryable: true,
    say: (h) => `连接 ${h} 超时：到该地址不通。若挂着代理，注意 Node 不读系统代理，需要 TUN / 增强模式`
  },
  {
    // undici 在发请求前就会拒绝 HTTP 规范里的保留端口（1/7/9/…），不会真的建连
    test: /bad port/i,
    kind: 'bad_port',
    retryable: false,
    say: (h) => `${h} 用的是 HTTP 规范禁止的保留端口，请求根本没发出去，请检查 base URL`
  },
  {
    test: /ECONNRESET|EPIPE|ECONNABORTED|UND_ERR_SOCKET|socket hang up/i,
    kind: 'reset',
    retryable: true,
    say: (h) => `与 ${h} 的连接被重置：长连接被代理或网关掐断`
  },
  {
    test: /ENETUNREACH|EHOSTUNREACH|ENETDOWN|EADDRNOTAVAIL/i,
    kind: 'unreachable',
    retryable: true,
    say: (h) => `网络不可达（${h}）：检查网卡、VPN 或防火墙`
  }
]

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}

/**
 * 把 fetch 抛出的任意错误转成一条能照着做的 network 失败。
 * 消息里带 host、底层错误码与耗时——这三样是排查的唯一抓手。
 */
export function networkFailure(err: unknown, url: string, elapsedMs: number): AgentFailure {
  const host = hostOf(url)
  const chain = flattenCause(err)
  const codes = chain.map((c) => c.code).filter(Boolean)
  const hay = [...codes, ...chain.map((c) => c.message), (err as Error)?.message ?? ''].join(' ')
  const rule = NET_RULES.find((r) => r.test.test(hay))
  // UND_ERR_* 是 undici 自己的包装码，能拿到系统码时优先显示系统码
  const code = codes.find((c) => !c.startsWith('UND_ERR')) ?? codes[0] ?? ''
  const detail = code || ((err as Error)?.message ?? 'network')
  const secs = (elapsedMs / 1000).toFixed(1)
  const base = rule ? rule.say(host) : `请求 ${host} 失败：${(err as Error)?.message ?? String(err)}`
  return new AgentFailure('network', `${base}（${detail}，${secs}s）`, {
    retryable: rule?.retryable ?? true,
    code: rule?.kind ?? 'network'
  })
}

/** Retry-After 支持秒数与 HTTP 日期两种写法；解析不了返回 undefined */
export function parseRetryAfterMs(raw: string | null | undefined): number | undefined {
  const t = (raw ?? '').trim()
  if (!t) return undefined
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000)
  const at = Date.parse(t)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
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

/** 根据 HTTP 状态映射错误类型。retryAfterMs 来自响应头，仅对限流/5xx 有意义。 */
export function classifyHttp(status: number, body: string, retryAfterMs?: number): AgentFailure {
  const detail = extractMessage(body)
  const snippet = detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`
  if (status === 401 || status === 403) return new AgentFailure('auth', snippet, { status })
  if (status === 429) return new AgentFailure('rate_limit', snippet, { status, retryAfterMs })
  if (status === 400 || status === 413 || status === 422) {
    const contextish = /context|too long|maximum|token limit|exceed/i.test(detail)
    return new AgentFailure(contextish ? 'context' : 'bad_response', snippet, { status })
  }
  if (status >= 500) return new AgentFailure('server', snippet, { status, retryAfterMs })
  return new AgentFailure('bad_response', snippet, { status })
}
