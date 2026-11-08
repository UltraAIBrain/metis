import type { AgentTool, ToolContext, ToolResult } from './types'
import { asString, ToolError } from './util'

/**
 * fetch：给 agent 用的极简网页阅读工具 —— GET 一个 http(s) 地址，HTML 剥成正文文本。
 * 只读、无 cookie、无 POST；正文与输出都有上限，超时 20s。
 * （agent 侧的"看文档/看报错页"用；给人用的浏览在面板里。）
 */

const TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 400_000
const MAX_OUT_CHARS = 30_000

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      try {
        return String.fromCodePoint(Number.parseInt(hex, 16))
      } catch {
        return ''
      }
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      try {
        return String.fromCodePoint(Number(dec))
      } catch {
        return ''
      }
    })
}

/** HTML → 文本：去 script/style/head 噪音，标签换空格，压缩空行；顺带取 <title> */
function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|pre|blockquote|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(stripped)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

export const fetchTool: AgentTool = {
  spec: {
    name: 'fetch',
    description:
      'Fetch an http(s) URL and return its content as plain text (HTML tags stripped, title extracted). ' +
      'Use it to read documentation pages, changelogs, error explanations or raw text/JSON files. ' +
      'Read-only GET, no cookies, 20s timeout, output capped — not a browser; for anything needing interaction use bash curl.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to GET.' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = asString(input, 'url', { required: true }).trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new ToolError(`无效的 URL：${url}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ToolError('只支持 http(s) 地址。')
    }

    let res: Response
    try {
      res = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; PiDesktopAgent/1.0)' }
      })
    } catch (err) {
      const name = (err as Error).name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ToolError(`请求超时（${TIMEOUT_MS / 1000}s）：${url}`)
      }
      throw new ToolError(`请求失败：${(err as Error).message}`)
    }

    if (!res.ok) {
      let snippet = ''
      try {
        snippet = (await res.text()).slice(0, 300)
      } catch {
        /* 忽略 */
      }
      return { content: `HTTP ${res.status} ${res.statusText}\n${snippet}`, isError: true }
    }

    // 限额读取：Content-Length 超限直接拒绝；流式读也封顶，防无长度声明的大响应
    const declared = Number(res.headers.get('content-length') ?? 0)
    if (declared > MAX_BODY_BYTES) {
      return { content: `响应体 ${declared} 字节，超过 ${MAX_BODY_BYTES} 上限；改用 bash 下载到文件再处理。`, isError: true }
    }
    const reader = res.body?.getReader()
    let raw = ''
    if (reader) {
      const decoder = new TextDecoder('utf-8', { fatal: false })
      let received = 0
      const chunks: string[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_BODY_BYTES) {
          await reader.cancel()
          return { content: `响应体超过 ${MAX_BODY_BYTES} 字节上限；改用 bash 下载到文件再处理。`, isError: true }
        }
        chunks.push(decoder.decode(value, { stream: true }))
      }
      chunks.push(decoder.decode())
      raw = chunks.join('')
    } else {
      raw = await res.text()
    }

    const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
    let text: string
    let title = ''
    if (ctype.includes('html') || (!ctype && raw.trimStart().startsWith('<'))) {
      const out = htmlToText(raw)
      title = out.title
      text = out.text
    } else if (ctype.includes('json') || ctype.includes('javascript') || ctype.includes('text') || !ctype) {
      text = raw
    } else {
      return { content: `不支持的响应类型：${ctype || '未知'}。二进制内容请用 bash 下载。`, isError: true }
    }

    if (!text.trim()) return { content: '响应正文为空。', isError: false }
    const clipped = text.length > MAX_OUT_CHARS ? `${text.slice(0, MAX_OUT_CHARS)}\n…（已截断，全文 ${text.length} 字符）` : text
    ctx.log('tool.fetch', { url: parsed.toString(), status: res.status, chars: text.length })
    return {
      content: `${title ? `标题：${title}\n` : ''}${clipped}`,
      isError: false
    }
  }
}
