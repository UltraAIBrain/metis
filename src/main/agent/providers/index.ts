import type { AgentError, ProviderId } from '@shared/types'
import { isLocalHost } from '../../../shared/providers'
import { AgentFailure } from '../errors'
import { createOpenAIProvider } from './openai'
import { createAnthropicProvider } from './anthropic'
import { createResponsesProvider } from './responses'
import type { Provider, ProviderLog, StreamRequest, StreamResult } from './types'

export function createProvider(id: ProviderId, baseUrl: string, apiKey: string, log?: ProviderLog): Provider {
  if (!apiKey && !isLocalHost(baseUrl)) {
    throw new AgentFailure(
      'config',
      '未配置凭据：请在设置中填写 API Key，或用 OAuth 登录（OpenAI Codex），或设置环境变量 OPENAI_API_KEY / ANTHROPIC_API_KEY'
    )
  }
  if (id === 'anthropic') return createAnthropicProvider(baseUrl, apiKey, log)
  if (id === 'responses') return createResponsesProvider(baseUrl, apiKey, log)
  return createOpenAIProvider(baseUrl, apiKey, log)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'))
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 一次失败后的退避决策，用于把「正在重连」同步给界面 */
export interface RetryNotice {
  /** 刚失败的是第几次尝试（1 起） */
  failed: number
  maxAttempts: number
  delayMs: number
  kind: AgentError['kind'] | 'unknown'
  message: string
}

export interface RetryOptions {
  /** 总尝试次数（含首次），默认 5 */
  maxAttempts?: number
  onRetry?: (notice: RetryNotice) => void
}

/**
 * 连接阶段的退避：0.5 → 1 → 2 → 4 → 8 秒，总窗口约 15s。
 * 真实抖动（切网、代理重连、Wi-Fi 漫游）通常 3–15s 才恢复，1.8s 的老窗口必然白给。
 */
const NETWORK_DELAYS = [500, 1000, 2000, 4000, 8000]
/** 限流 / 5xx 起步更缓：对端往往需要更长时间恢复 */
const SERVER_DELAYS = [1000, 2000, 4000, 8000]
/** 单次运行花在重试上的总时长上限，防止"一直转圈"被误认为卡死 */
const NETWORK_BUDGET_MS = 25_000
const SERVER_BUDGET_MS = 60_000
/** Retry-After 再大也不干等超过这个数 */
const MAX_RETRY_AFTER_MS = 60_000

function backoff(failure: AgentFailure | null, attempt: number): { delay: number; budget: number } {
  // 服务端明确给了 Retry-After 就照办，别自作聪明按自己的节奏撞墙
  if (failure?.retryAfterMs != null) {
    return {
      delay: Math.min(Math.max(failure.retryAfterMs, 0), MAX_RETRY_AFTER_MS),
      budget: SERVER_BUDGET_MS
    }
  }
  const isNetwork = failure?.kind !== 'rate_limit' && failure?.kind !== 'server'
  const table = isNetwork ? NETWORK_DELAYS : SERVER_DELAYS
  const base = table[Math.min(attempt, table.length - 1)]
  // ±20% 抖动：多个客户端同时重试时错开，避免同一秒再次撞墙
  return {
    delay: Math.round(base * (0.8 + Math.random() * 0.4)),
    budget: isNetwork ? NETWORK_BUDGET_MS : SERVER_BUDGET_MS
  }
}

/**
 * 带重试的流式请求。
 *
 * 三条硬规则，都是主流 CLI（Codex / Claude Code）共有的：
 * 1. **已经推过 token 就不再重试**——否则界面上出现重复文本 / 重影思考；
 * 2. **只重试可恢复的错误**（网络、限流、5xx）；401/403/400/证书错误立刻失败，重试纯浪费；
 * 3. **有总预算**，超了就把原始错误交出去，不让界面无限"运行中"。
 */
export async function streamWithRetry(
  provider: Provider,
  req: StreamRequest,
  log: (event: string, data?: unknown) => void,
  opts: RetryOptions = {}
): Promise<StreamResult> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5)
  let emitted = false
  const wrapped: StreamRequest = {
    ...req,
    onTextDelta: (t) => {
      emitted = true
      req.onTextDelta(t)
    },
    onThinkingDelta: (t) => {
      emitted = true
      req.onThinkingDelta?.(t)
    }
  }

  const startedAt = Date.now()
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await provider.stream(wrapped)
    } catch (err) {
      lastErr = err
      if (req.signal.aborted) throw err
      const failure = err instanceof AgentFailure ? err : null
      const canRetry = Boolean(failure?.retryable) && !emitted && attempt < maxAttempts - 1
      if (!canRetry) throw err
      const { delay, budget } = backoff(failure, attempt)
      const spent = Date.now() - startedAt
      if (spent + delay > budget) {
        log('provider.give_up', { failed: attempt + 1, spent, delay, budget, kind: failure?.kind })
        throw err
      }
      log('provider.retry', {
        failed: attempt + 1,
        delay,
        kind: failure?.kind,
        message: failure?.message
      })
      opts.onRetry?.({
        failed: attempt + 1,
        maxAttempts,
        delayMs: delay,
        kind: failure?.kind ?? 'unknown',
        message: failure?.message ?? String(err)
      })
      await sleep(delay, req.signal)
    }
  }
  throw lastErr
}

export type { Provider, StreamRequest, StreamResult }
