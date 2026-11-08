import type { ModelInput } from './types'

/**
 * 模型参数的内置兜底表。
 *
 * 只在服务商的 `/models` 接口没给元数据时使用（多数国内中转只返回 id）。
 * 数据来源是各家公开文档；**接口返回的值永远优先**，因为中转可能改写上限。
 */
export interface ModelProfile {
  label?: string
  /** 上下文窗口（tokens） */
  contextWindow?: number
  /** 最大输出 tokens */
  maxOutput?: number
  inputs?: ModelInput[]
}

interface CatalogEntry extends ModelProfile {
  match: RegExp
}

const K = 1000
const M = 1_000_000

const ENTRIES: CatalogEntry[] = [
  // 智谱 GLM（docs.bigmodel.cn）
  { match: /^glm-5\.3-flash/i, label: 'GLM-5.3-Flash', contextWindow: 1 * M, maxOutput: 131072, inputs: ['text', 'image'] },
  { match: /^glm-5\.3/i, label: 'GLM-5.3', contextWindow: 1 * M, maxOutput: 131072, inputs: ['text'] },
  { match: /^glm-4\.6/i, label: 'GLM-4.6', contextWindow: 200 * K, maxOutput: 131072, inputs: ['text', 'image'] },
  { match: /^glm-4\.5/i, label: 'GLM-4.5', contextWindow: 128 * K, maxOutput: 98304, inputs: ['text'] },
  { match: /^glm-4/i, label: 'GLM-4', contextWindow: 128 * K, maxOutput: 8192, inputs: ['text'] },
  // Anthropic
  { match: /^claude-[a-z0-9.-]*-5/i, contextWindow: 200 * K, maxOutput: 64000, inputs: ['text', 'image'] },
  { match: /^claude-[a-z0-9.-]*-4/i, contextWindow: 200 * K, maxOutput: 32000, inputs: ['text', 'image'] },
  { match: /^claude/i, contextWindow: 200 * K, maxOutput: 8192, inputs: ['text', 'image'] },
  // OpenAI
  { match: /^gpt-5/i, contextWindow: 400 * K, maxOutput: 128 * K, inputs: ['text', 'image'] },
  { match: /^o[34]/i, contextWindow: 200 * K, maxOutput: 100 * K, inputs: ['text', 'image'] },
  { match: /^gpt-4o/i, contextWindow: 128 * K, maxOutput: 16384, inputs: ['text', 'image'] },
  // DeepSeek
  { match: /^deepseek-(r1|reasoner)/i, contextWindow: 64 * K, maxOutput: 8192, inputs: ['text'] },
  { match: /^deepseek/i, contextWindow: 128 * K, maxOutput: 8192, inputs: ['text'] },
  // Moonshot / 其他常见开源
  { match: /^kimi-k2/i, contextWindow: 256 * K, maxOutput: 32768, inputs: ['text'] },
  { match: /^qwen3/i, contextWindow: 128 * K, maxOutput: 16384, inputs: ['text'] }
]

/** 按模型名查内置参数；id 可能带厂商前缀（如 zhipu/glm-5.3），先剥掉再匹配 */
export function lookupModel(id: string): ModelProfile | undefined {
  const raw = (id || '').trim()
  if (!raw) return undefined
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  for (const entry of ENTRIES) {
    if (entry.match.test(bare)) {
      return { label: entry.label, contextWindow: entry.contextWindow, maxOutput: entry.maxOutput, inputs: entry.inputs }
    }
  }
  return undefined
}

/** 1000000 → 1M；131072 → 128K；8192 → 8K */
export function formatTokens(n?: number): string {
  if (!n || n <= 0) return '未知'
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`
  }
  // 131072 这种是 1024 的整数倍，按 1024 除更准（128K），其余按 1000
  if (n >= 1000) return n % 1024 === 0 ? `${n / 1024}K` : `${Math.round(n / 1000)}K`
  return String(n)
}

export function describeInputs(inputs?: ModelInput[]): string {
  if (!inputs || !inputs.length) return '未知'
  const names: Record<ModelInput, string> = { text: '文本', image: '图片', file: '文件', audio: '音频', video: '视频' }
  return inputs.map((i) => names[i] ?? i).join(' / ')
}
