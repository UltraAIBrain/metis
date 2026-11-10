import { AgentFailure, classifyHttp, networkFailure, parseRetryAfterMs } from '../errors'

/**
 * 空闲超时：连接没断但迟迟没有新数据时，不能无限等下去。
 * 用 120s 是因为推理模型"先想很久再出字"很常见，太短会误杀。
 */
const IDLE_TIMEOUT_MS = 120_000
const HEADER_TIMEOUT_MS = 60_000

interface SseOptions {
  /** 用户中断信号；中止时不再把 reader.read() 的错误当成网络问题 */
  signal?: AbortSignal
  idleMs?: number
}

/**
 * 按 SSE 规范解析：以空行为事件分隔，同一事件的多行 `data:` 用 \n 拼接后产出；
 * event:/id:/retry:/注释行忽略。每读到一块数据就重置空闲计时器，
 * 卡住的连接会在超时后抛 network 错误（可重试）。
 */
export async function* sseData(res: Response, opts: SseOptions = {}): AsyncGenerator<string> {
  if (!res.body) throw new AgentFailure('bad_response', '模型服务返回了空响应体')
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  const idleMs = opts.idleMs ?? IDLE_TIMEOUT_MS
  let buffer = ''
  let dataLines: string[] = []

  const readOnce = (): Promise<{ done: boolean; value?: Uint8Array }> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AgentFailure('network', `等待模型响应超时：${Math.round(idleMs / 1000)} 秒内没有收到任何数据`, {
            retryable: true
          })
        )
      }, idleMs)

      reader.read().then(
        (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })

  function* flushEvent(): Generator<string> {
    if (!dataLines.length) return
    const payload = dataLines.join('\n')
    dataLines = []
    if (payload.trim()) yield payload
  }

  try {
    for (;;) {
      const { done, value } = await readOnce()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line === '') {
          yield* flushEvent()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
        nl = buffer.indexOf('\n')
      }
    }
    // 流结束：残余不带换行的最后一行与未 flush 的事件也要处理
    const tail = buffer.replace(/\r$/, '')
    if (tail.startsWith('data:')) dataLines.push(tail.slice(5).replace(/^ /, ''))
    yield* flushEvent()
  } catch (err) {
    // 超时或中断后要显式取消，否则连接会挂在那里占着资源
    try {
      await reader.cancel()
    } catch {
      /* 已关闭 */
    }
    throw err
  } finally {
    reader.releaseLock()
  }
}

/** 非 2xx 统一转成可分类错误；限流/5xx 会把 Retry-After 带下去给重试策略。 */
export async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return
  let body = ''
  try {
    body = await res.text()
  } catch {
    /* 忽略读取失败 */
  }
  throw classifyHttp(res.status, body, parseRetryAfterMs(res.headers.get('retry-after')))
}

/**
 * fetch 的网络层异常包装：响应头超时后中止连接，外部中断信号继续覆盖响应体。
 * 失败时统一走 networkFailure()，把 cause 链摊平成一句可操作的话——
 * 只报 "fetch failed" 等于没报（DNS / 端口 / 超时 / 证书 全一样）。
 */
export async function request(url: string, init: RequestInit, timeoutMs = HEADER_TIMEOUT_MS): Promise<Response> {
  const started = Date.now()
  const controller = new AbortController()
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal })
  } catch (err) {
    if (init.signal?.aborted) throw err
    const elapsed = Date.now() - started
    if (controller.signal.aborted) {
      throw new AgentFailure(
        'network',
        `等待 ${hostOf(url)} 的响应头超时（${Math.round(timeoutMs / 1000)}s，已等 ${(elapsed / 1000).toFixed(1)}s）`,
        { retryable: true, code: 'header_timeout' }
      )
    }
    if ((err as Error).name === 'AbortError') throw err
    throw networkFailure(err, url, elapsed)
  } finally {
    clearTimeout(timer)
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}

export function safeJsonParse(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || '{}') as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* 统一转成可读的 provider 错误，绝不把破损参数交给工具执行 */
  }
  throw new AgentFailure(
    'bad_response',
    `模型返回了无法解析的工具参数（${text.slice(0, 200) || '空'}），已取消本次工具调用`
  )
}
