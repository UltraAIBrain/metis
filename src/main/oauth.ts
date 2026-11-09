import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { ConfigStore, StoredProfile } from './config'
import { logger } from './logger'

/**
 * OpenAI OAuth（PKCE + 本地回环重定向），与 Codex CLI 同款公开客户端：
 * 浏览器打开 auth.openai.com/authorize → 登录后跳回 http://localhost:1455/auth/callback
 * → 用 code + code_verifier 换 access/refresh token。
 *
 * access token 短效（约 1 小时），refresh token 长效；过期前自动刷新并写回配置。
 * 端点与端口都做成可注入，冒烟测试用本地假服务跑完整链路。
 */

export const OPENAI_AUTH_BASE = 'https://auth.openai.com'
export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_REDIRECT_PORT = 1455

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  /** access token 过期时间（epoch ms）；取自 JWT exp，缺失时按 expires_in 估算 */
  expiresAt?: number
  /** 登录账号（id_token 里的 email），仅展示用 */
  account?: string
}

export interface OauthEndpoints {
  authBase?: string
  clientId?: string
  /** 本地回调端口；测试时用随机端口避免与真实服务冲突 */
  port?: number
  timeoutMs?: number
  /** 拿到授权 URL 后如何交给用户（桌面版开浏览器；终端版直接打印） */
  open?: (url: string) => void
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PKCE：verifier 64 字符 base64url；challenge = SHA256(verifier) 的 base64url */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** 解 JWT payload（不验签：只读 exp / email 做本地判断，token 真伪由服务端把关） */
export function decodeJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

function tokensFrom(json: Record<string, unknown>): OAuthTokens {
  const accessToken = typeof json.access_token === 'string' ? json.access_token : ''
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : ''
  if (!accessToken || !refreshToken) {
    throw new Error(
      `token 响应缺少字段：${json.error_description ?? json.error ?? '无 access_token / refresh_token'}`
    )
  }
  const payload = decodeJwt(accessToken)
  const exp = typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined
  const idPayload = typeof json.id_token === 'string' ? decodeJwt(json.id_token) : null
  const account =
    (typeof idPayload?.email === 'string' && idPayload.email) ||
    (typeof payload?.email === 'string' && payload.email) ||
    undefined
  return {
    accessToken,
    refreshToken,
    expiresAt: exp ?? (typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : undefined),
    account: account || undefined
  }
}

async function tokenRequest(
  url: string,
  body: Record<string, string>,
  timeoutMs = 20_000
): Promise<OAuthTokens> {
  // 端点守卫：只允许 https 或本机回环（回环供测试注入假认证服务）。
  // 防 SSRF：code_verifier / refresh_token 永不发往非预期主机。
  const endpoint = new URL(url)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !loopback) {
    throw new Error(`拒绝向非 https 端点发送凭据：${url}`)
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    throw new Error(`无法连接认证服务（${url}）：${(err as Error).message}`)
  }
  const text = await res.text()
  if (!res.ok) {
    let detail = text
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      const v = parsed.error_description ?? parsed.error ?? text
      detail = typeof v === 'string' ? v : JSON.stringify(v)
    } catch {
      /* 保留原文 */
    }
    throw new Error(`token 接口返回 ${res.status}：${detail.slice(0, 200)}`)
  }
  try {
    return tokensFrom(JSON.parse(text) as Record<string, unknown>)
  } catch (err) {
    throw new Error(`token 响应解析失败：${(err as Error).message}`)
  }
}

/** 用授权码换 token（PKCE） */
export function exchangeCode(
  code: string,
  verifier: string,
  opts: Pick<OauthEndpoints, 'authBase' | 'clientId' | 'port'> = {}
): Promise<OAuthTokens> {
  const authBase = opts.authBase ?? OPENAI_AUTH_BASE
  const port = opts.port ?? OPENAI_REDIRECT_PORT
  return tokenRequest(`${authBase}/oauth/token`, {
    grant_type: 'authorization_code',
    client_id: opts.clientId ?? OPENAI_OAUTH_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: `http://localhost:${port}/auth/callback`
  })
}

/** 用 refresh token 换新的 access token（refresh token 可能轮换，一并更新） */
export function refreshTokens(
  refreshToken: string,
  opts: Pick<OauthEndpoints, 'authBase' | 'clientId'> = {}
): Promise<OAuthTokens> {
  const authBase = opts.authBase ?? OPENAI_AUTH_BASE
  return tokenRequest(`${authBase}/oauth/token`, {
    grant_type: 'refresh_token',
    client_id: opts.clientId ?? OPENAI_OAUTH_CLIENT_ID,
    refresh_token: refreshToken
  })
}

export function buildAuthorizeUrl(opts: { challenge: string; state: string } & OauthEndpoints): string {
  const authBase = opts.authBase ?? OPENAI_AUTH_BASE
  const port = opts.port ?? OPENAI_REDIRECT_PORT
  const params = new URLSearchParams({
    client_id: opts.clientId ?? OPENAI_OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `http://localhost:${port}/auth/callback`,
    scope: 'openid profile email offline_access',
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    state: opts.state
  })
  return `${authBase}/authorize?${params.toString()}`
}

export interface LoginHandle {
  promise: Promise<OAuthTokens>
  /** 用户取消 / 超时前主动终止（关闭回调服务） */
  cancel(reason?: string): void
}

/**
 * 完整登录流：起本地回调服务 → 生成授权 URL 交给 open() → 等浏览器带回 code → 换 token。
 * 任意环节失败都会关掉服务并 reject。
 */
export function startLogin(opts: OauthEndpoints = {}): LoginHandle {
  const port = opts.port ?? OPENAI_REDIRECT_PORT
  const timeoutMs = opts.timeoutMs ?? 300_000
  const { verifier, challenge } = makePkce()
  const state = b64url(randomBytes(16))
  const url = buildAuthorizeUrl({ ...opts, challenge, state })

  let server: Server | null = null
  let timer: NodeJS.Timeout | null = null
  let settled = false

  const cleanup = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    server?.close()
    server = null
  }

  const promise = new Promise<OAuthTokens>((resolve, reject) => {
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (u.pathname !== '/auth/callback') {
        res.writeHead(404).end()
        return
      }
      const code = u.searchParams.get('code')
      const errParam = u.searchParams.get('error')
      const backState = u.searchParams.get('state')
      // 先给浏览器回话，再处理结果，用户不用等服务端
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body style="font-family:system-ui;padding:40px;text-align:center">' +
          (code && backState === state
            ? '<h2>登录成功</h2><p>可以回到 Metis 继续使用。</p>'
            : '<h2>登录未完成</h2><p>请回到应用重试。</p>') +
          '</body></html>'
      )
      if (errParam) {
        fail(new Error(`授权失败：${errParam}`))
        return
      }
      if (!code) {
        fail(new Error('回调缺少授权码'))
        return
      }
      if (backState !== state) {
        fail(new Error('回调 state 不匹配（可能不是本次登录发起的请求）'))
        return
      }
      exchangeCode(code, verifier, opts)
        .then((tokens) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(tokens)
        })
        .catch(fail)
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      fail(
        err.code === 'EADDRINUSE'
          ? new Error(`本地回调端口 ${port} 被占用（是否已有一次登录在进行？）`)
          : new Error(`本地回调服务启动失败：${err.message}`)
      )
    })

    server.listen(port, '127.0.0.1', () => {
      opts.open?.(url)
    })

    timer = setTimeout(() => fail(new Error(`登录超时（${Math.round(timeoutMs / 1000)}s 内未完成浏览器授权）`)), timeoutMs)
  })

  return {
    promise,
    cancel: (reason) => {
      /* promise 无法外部 reject，这里只负责关服务；调用方对 promise 的 await 会随超时/异常结束 */
      cleanup()
      logger.info('oauth.login_cancelled', { reason: reason ?? 'user' })
    }
  }
}

/* ---------------- 与配置的衔接（主进程 / CLI 共用） ---------------- */

/** 该档案是否用 OAuth（目前只有 Codex/ChatGPT 登录这一条链路） */
export function hasOAuth(profile: StoredProfile): boolean {
  return profile.protocol === 'responses'
}

/**
 * 解析档案的请求凭据：OAuth 档案用 access token（过期自动刷新并写回配置），
 * 其余走 API Key / 环境变量。runner 每次构造 provider 前调用。
 * opts 只用于测试注入假端点，生产调用不传。
 */
export async function resolveBearer(
  config: ConfigStore,
  profile: StoredProfile,
  opts: Pick<OauthEndpoints, 'authBase' | 'clientId'> = {}
): Promise<string> {
  if (hasOAuth(profile)) {
    const stored = config.oauthFor(profile.id)
    if (stored?.refreshToken) {
      let tokens = stored
      // 过期（或快过期）才刷新：提前 60s，避免临界请求带着将失效的 token
      if (!tokens.accessToken || (tokens.expiresAt ?? 0) - 60_000 < Date.now()) {
        try {
          tokens = await refreshTokens(tokens.refreshToken, opts)
          config.setOAuth(profile.id, tokens)
          logger.info('oauth.token_refreshed', { profile: profile.id, account: tokens.account })
        } catch (err) {
          logger.warn('oauth.refresh_failed', { profile: profile.id, message: (err as Error).message })
          throw new Error(
            `OpenAI 登录已过期且自动续期失败：${(err as Error).message}。请在设置里重新登录（或改用 API Key）。`
          )
        }
      }
      return tokens.accessToken
    }
    // 没有 OAuth 凭据时回落 API Key（用户也可以给 Codex 后端配网关 token）
  }
  return config.apiKeyFor(profile.id).key
}
