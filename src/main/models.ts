import type { ModelInput, ModelOption, Protocol } from '@shared/types'
import { lookupModel } from '../shared/model-catalog'
import { AgentFailure, classifyHttp } from './agent/errors'

const TIMEOUT_MS = 15_000
const MAX_MODELS = 500

function trimBase(baseUrl: string): string {
  return (baseUrl || '').trim().replace(/\/+$/, '')
}

/** Anthropic 的 baseUrl 可能带或不带 /v1，这里统一。 */
function anthropicUrl(base: string): string {
  return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    const name = (err as Error).name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new AgentFailure('network', `读取模型列表超时（${TIMEOUT_MS / 1000}s）：${url}`)
    }
    throw new AgentFailure('network', `无法连接 ${url}：${(err as Error).message}`)
  }

  if (!res.ok) {
    let body = ''
    try {
      body = await res.text()
    } catch {
      /* 忽略 */
    }
    if (res.status === 404) {
      throw new AgentFailure('bad_response', `该服务未提供 /models 接口（HTTP 404）：${url}。可手动输入模型名。`, {
        status: 404
      })
    }
    throw classifyHttp(res.status, body)
  }

  try {
    return await res.json()
  } catch {
    throw new AgentFailure('bad_response', `模型列表返回的不是合法 JSON：${url}`)
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const INPUTS = new Set<ModelInput>(['text', 'image', 'file', 'audio', 'video'])

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined
}

/** 按 "a.b.c" 路径取第一个正整数；不同服务商字段名各不相同，只能挨个试 */
function pickNumber(obj: Record<string, unknown>, paths: string[]): number | undefined {
  for (const path of paths) {
    let cur: unknown = obj
    for (const key of path.split('.')) {
      cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined
    }
    const n = positive(cur)
    if (n) return n
  }
  return undefined
}

function pickInputs(obj: Record<string, unknown>): ModelInput[] | undefined {
  const raw =
    (obj.architecture as Record<string, unknown> | undefined)?.input_modalities ??
    obj.input_modalities ??
    (obj.modalities as Record<string, unknown> | undefined)?.input
  if (Array.isArray(raw)) {
    const list = raw.filter((x): x is ModelInput => typeof x === 'string' && INPUTS.has(x as ModelInput))
    if (list.length) return list
  }
  // 有些服务商只给能力标记
  if ((obj.capabilities as Record<string, unknown> | undefined)?.vision === true) return ['text', 'image']
  return undefined
}

interface ApiMeta {
  contextWindow?: number
  maxOutput?: number
  inputs?: ModelInput[]
}

function apiMeta(obj: Record<string, unknown>): ApiMeta {
  return {
    contextWindow: pickNumber(obj, [
      'context_length',
      'context_window',
      'max_context_length',
      'top_provider.context_length',
      'limits.context_window'
    ]),
    maxOutput: pickNumber(obj, [
      'max_output_tokens',
      'max_completion_tokens',
      'top_provider.max_completion_tokens',
      'limits.max_output_tokens'
    ]),
    inputs: pickInputs(obj)
  }
}

/** 接口给的值优先，缺的用内置表补；顺便标出来源 */
function withMeta(id: string, base: ModelOption, meta: ApiMeta): ModelOption {
  const cat = lookupModel(id) ?? {}
  const fromApi = Boolean(meta.contextWindow || meta.maxOutput || meta.inputs)
  const contextWindow = meta.contextWindow ?? cat.contextWindow
  const maxOutput = meta.maxOutput ?? cat.maxOutput
  return {
    ...base,
    label: base.label ?? cat.label,
    contextWindow,
    maxOutput,
    inputs: meta.inputs ?? cat.inputs,
    metaSource: fromApi ? 'api' : contextWindow || maxOutput ? 'catalog' : undefined
  }
}

function normalizeOpenAI(payload: unknown): ModelOption[] {
  const root = payload as { data?: unknown[]; models?: unknown[] } | null
  const list = Array.isArray(root?.data) ? root.data : Array.isArray(root?.models) ? root.models : []
  const out: ModelOption[] = []

  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ id: item })
      continue
    }
    const obj = item as Record<string, unknown>
    const id = asString(obj.id) || asString(obj.name) || asString(obj.model)
    if (!id) continue
    const owned = asString(obj.owned_by)
    const created = typeof obj.created === 'number' ? new Date(obj.created * 1000).toISOString().slice(0, 10) : ''
    out.push(
      withMeta(id, { id, hint: [owned, created].filter(Boolean).join(' · ') || undefined }, apiMeta(obj))
    )
  }
  return out
}

function normalizeAnthropic(payload: unknown): ModelOption[] {
  const root = payload as { data?: unknown[] } | null
  const list = Array.isArray(root?.data) ? root.data : []
  const out: ModelOption[] = []

  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ id: item })
      continue
    }
    const obj = item as Record<string, unknown>
    const id = asString(obj.id)
    if (!id) continue
    out.push(withMeta(id, { id, label: asString(obj.display_name) || undefined }, apiMeta(obj)))
  }
  return out
}

/**
 * 读取服务商支持的模型名。
 * OpenAI 兼容族走 GET {base}/models；Anthropic 走 GET /v1/models；
 * responses（ChatGPT 登录）后端不一定提供列表，失败时回退一份 Codex 常用候选（仍可手输）。
 */
const CODEX_FALLBACK_MODELS = ['gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex', 'gpt-5.1', 'gpt-5']

export async function listModels(protocol: Protocol, baseUrl: string, apiKey: string): Promise<ModelOption[]> {
  const base = trimBase(baseUrl)
  if (!base) throw new AgentFailure('config', '请先填写 Base URL')

  let payload: unknown

  if (protocol === 'anthropic') {
    const url = anthropicUrl(base)
    payload = await getJson(url, {
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      'anthropic-version': '2023-06-01'
    })
  } else {
    const url = `${base}/models`
    const headers: Record<string, string> = {}
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    try {
      payload = await getJson(url, headers)
    } catch (err) {
      if (protocol === 'responses') {
        // ChatGPT 后端没有公开 /models：给一份候选让用户选，参数由内置表补
        return CODEX_FALLBACK_MODELS.map((id) => withMeta(id, { id }, { contextWindow: undefined, maxOutput: undefined, inputs: undefined }))
      }
      throw err
    }
  }

  const normalized = protocol === 'anthropic' ? normalizeAnthropic(payload) : normalizeOpenAI(payload)
  normalized.sort((a, b) => a.id.localeCompare(b.id))
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const model of normalized) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
    if (models.length === MAX_MODELS) break
  }

  if (!models.length) {
    throw new AgentFailure('bad_response', '接口返回了空模型列表，可能该 Key 没有可用模型权限。可手动输入模型名。')
  }
  return models
}
