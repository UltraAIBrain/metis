import type { Protocol } from './types'

/**
 * 固定的提供商清单。
 * 这里刻意不写死任何模型名——模型一律在运行时通过各家的 /models 接口拉取后手选，
 * 避免代码里塞一堆很快就过期的模型 ID。
 */
export interface ProviderPreset {
  id: string
  /** 列表里显示的主名，就是这个 id */
  short: string
  /** 中文说明 */
  label: string
  protocol: Protocol
  baseUrl: string
  /** 命中这些 host（可含端口）即认为是用这家 */
  hosts: string[]
  /** 同一 host 下靠路径区分，例如 z.ai 的 /api/anthropic */
  pathHint?: string
  note?: string
  local?: boolean
}

export const PRESETS: ProviderPreset[] = [
  {
    id: 'openai-codex',
    short: 'openai-codex',
    label: 'OpenAI Codex（ChatGPT 登录）',
    protocol: 'responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    hosts: ['chatgpt.com'],
    pathHint: '/codex',
    note: 'ChatGPT Plus/Pro 订阅，OAuth 登录，无需 API Key'
  },
  {
    id: 'kimi',
    short: 'kimi',
    label: 'Kimi 开放平台',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    hosts: ['api.moonshot.cn', 'api.moonshot.ai'],
    note: '按量付费的 Moonshot 开放平台'
  },
  {
    id: 'kimi-coding',
    short: 'kimi-coding',
    label: 'Kimi Coding 订阅',
    protocol: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding',
    hosts: ['api.kimi.com', 'api.kimi.ai'],
    pathHint: '/coding',
    note: 'Anthropic 协议；用 Kimi Code 的订阅 Key'
  },
  {
    id: 'zai',
    short: 'zai',
    label: 'Z.ai 开放平台',
    protocol: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    hosts: ['api.z.ai', 'open.bigmodel.cn'],
    note: '国内站把域名换成 open.bigmodel.cn'
  },
  {
    id: 'zai-coding',
    short: 'zai-coding',
    label: 'Z.ai Coding 订阅',
    protocol: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic',
    hosts: ['api.z.ai', 'open.bigmodel.cn'],
    pathHint: '/anthropic',
    note: 'Anthropic 协议；用 Coding Plan 的 Key'
  },
  {
    id: 'deepseek',
    short: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    hosts: ['api.deepseek.com'],
    note: 'Anthropic 协议把地址改成 https://api.deepseek.com/anthropic'
  }
]

export function presetById(id: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.id === id)
}

/** 展示用短名：预设用 id，自定义档案用它的 label */
export function profileShortName(profile: { id: string; label: string }): string {
  return presetById(profile.id)?.short ?? profile.label
}

function parse(baseUrl: string): URL | null {
  const raw = (baseUrl || '').trim()
  if (!raw) return null
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
}

function hostMatches(pattern: string, host: string, hostPort: string): boolean {
  const p = pattern.toLowerCase()
  if (p.includes(':')) return hostPort === p
  return host === p || host.endsWith(`.${p}`)
}

/** 从 baseUrl 反查是哪家：host 不够用时再看路径（coding 订阅与开放平台同域不同路径）。 */
export function detectPreset(baseUrl: string): ProviderPreset | undefined {
  const url = parse(baseUrl)
  if (!url) return undefined
  const host = url.hostname.toLowerCase()
  const hostPort = url.host.toLowerCase()
  const path = url.pathname.toLowerCase()

  const hits = PRESETS.filter((p) => {
    if (!p.hosts.some((h) => hostMatches(h, host, hostPort))) return false
    return !p.pathHint || path.includes(p.pathHint.toLowerCase())
  })

  // 路径条件越长越具体，优先匹配
  hits.sort((a, b) => (b.pathHint?.length ?? 0) - (a.pathHint?.length ?? 0))
  return hits[0]
}

/** 地址认不出来时，按路径特征猜协议族：/anthropic 按 Anthropic 处理，/codex 按 Responses 处理。 */
export function inferProtocol(baseUrl: string): Protocol {
  const url = parse(baseUrl)
  if (url && /\/anthropic(\/|$)/i.test(url.pathname)) return 'anthropic'
  if (url && /\/codex(\/|$)/i.test(url.pathname)) return 'responses'
  const preset = detectPreset(baseUrl)
  if (preset) return preset.protocol
  return /anthropic/i.test(baseUrl || '') ? 'anthropic' : 'openai'
}

export function isLocalHost(baseUrl: string): boolean {
  const preset = detectPreset(baseUrl)
  if (preset?.local) return true
  // host 后必须是端口、路径或结束，防止 http://localhost.evil.com 之类绕过
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test((baseUrl || '').trim())
}
