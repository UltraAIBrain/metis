import type { ModelOption, ProfilePatch, Protocol, PublicProfile } from '@shared/types'
import { isLocalHost, presetById } from '@shared/providers'

/** 设置面板里的提供商草稿：保存前只在内存里改 */
export interface Draft {
  id: string
  label: string
  protocol: Protocol
  baseUrl: string
  apiKey?: string
  clearKey?: boolean
  /** OAuth 登录状态（token 本体只在主进程，这里仅展示） */
  oauth?: { connected: true; account?: string }
  models: ModelOption[]
  modelsFetchedAt?: number
  hasKey: boolean
  local: boolean
  note?: string
  custom: boolean
}

export function toDraft(p: PublicProfile): Draft {
  const preset = presetById(p.id)
  return {
    id: p.id,
    label: p.label,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    oauth: p.oauth,
    models: p.models,
    modelsFetchedAt: p.modelsFetchedAt,
    hasKey: p.hasKey,
    local: isLocalHost(p.baseUrl),
    note: preset?.note,
    custom: !preset
  }
}

export function freshDraft(id: string, base: Partial<Draft> = {}): Draft {
  const preset = presetById(id)
  return {
    id,
    label: preset?.label ?? '自定义',
    protocol: preset?.protocol ?? 'openai',
    baseUrl: preset?.baseUrl ?? '',
    // 模型候选一律运行时读取，这里不预置
    models: [],
    hasKey: false,
    local: Boolean(preset?.local),
    note: preset?.note,
    custom: !preset,
    ...base
  }
}

export function toPatch(d: Draft): ProfilePatch {
  return {
    id: d.id,
    label: d.label,
    protocol: d.protocol,
    baseUrl: d.baseUrl,
    apiKey: d.apiKey,
    clearKey: d.clearKey,
    models: d.models,
    modelsFetchedAt: d.modelsFetchedAt
  }
}

/** 模型列表的新鲜度，用于提示文案 */
export function freshness(ts?: number): string {
  if (!ts) return '从未更新'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚更新'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前更新`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前更新`
  return `${Math.floor(diff / 86_400_000)} 天前更新`
}
