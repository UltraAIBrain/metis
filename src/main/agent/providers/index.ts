import type { ProviderId } from '@shared/types'
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

/**
 * 瞬时错误最多重试 2 次（600ms / 1200ms 退避）。
 * 一旦已经向 UI 推过内容（正文或思维链）就不再重试——否则会出现重复文本/重影思考。
 */
export async function streamWithRetry(
  provider: Provider,
  req: StreamRequest,
  log: (event: string, data?: unknown) => void,
  attempts = 3
): Promise<StreamResult> {
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

  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await provider.stream(wrapped)
    } catch (err) {
      lastErr = err
      if (req.signal.aborted) throw err
      const failure = err instanceof AgentFailure ? err : null
      const canRetry = Boolean(failure?.retryable) && !emitted && i < attempts - 1
      if (!canRetry) throw err
      const delay = 600 * 2 ** i
      log('provider.retry', { attempt: i + 1, delay, kind: failure?.kind, message: failure?.message })
      await sleep(delay, req.signal)
    }
  }
  throw lastErr
}

export type { Provider, StreamRequest, StreamResult }
