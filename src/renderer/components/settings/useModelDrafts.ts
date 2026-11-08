import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProfilePatch, Protocol, PublicConfig } from '@shared/types'
import { PRESETS, detectPreset, isLocalHost } from '@shared/providers'
import { cleanIpcError } from '../../store'
import type { Draft } from './draft'
import { freshDraft, toDraft, toPatch } from './draft'

export interface ProviderRow {
  id: string
  short: string
  desc: string
  protocol: Protocol
  baseUrl: string
  hasKey: boolean
  /** OAuth 已登录（ChatGPT 订阅） */
  oauth?: boolean
}

/**
 * 模型服务的全部编辑状态：提供商草稿、当前选中的档案、默认模型、模型列表。
 * 放在 hook 里，让设置面板的 UI 只负责渲染。
 */
export function useModelDrafts(config: PublicConfig) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const map: Record<string, Draft> = {}
    for (const p of config.profiles) map[p.id] = toDraft(p)
    return map
  })
  const [activeId, setActiveId] = useState(config.activeProfileId)
  const [model, setModel] = useState(config.model)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const draftsRef = useRef(drafts)
  const activeIdRef = useRef(activeId)
  draftsRef.current = drafts
  activeIdRef.current = activeId

  const active = drafts[activeId] ?? drafts[config.activeProfileId]
  const detected = active ? detectPreset(active.baseUrl) : undefined
  /** OAuth 档案凭据齐了就算配置完成，不要求 API Key */
  const hasCredential = (d: Draft | undefined): boolean =>
    Boolean(d && (d.hasKey || d.apiKey || d.local || d.oauth?.connected))
  const needsKey = active ? !hasCredential(active) : true

  const patchDraft = (id: string, patch: Partial<Draft>): void => {
    setDrafts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev))
  }

  const loadModels = async (target?: Draft): Promise<void> => {
    const d = target ?? active
    if (!d) return
    if (!d.baseUrl.trim()) {
      setError('请先填写 Base URL')
      return
    }
    if (!hasCredential(d)) {
      setError(d.protocol === 'responses' ? '请先用 OpenAI 登录，再读取模型列表' : '请先填写 API Key，再读取模型列表')
      return
    }

    const request = ++requestSeq.current
    setLoading(true)
    setError(null)
    const isCurrent = (): boolean => {
      const latest = draftsRef.current[d.id]
      return (
        request === requestSeq.current &&
        latest?.baseUrl === d.baseUrl &&
        latest?.protocol === d.protocol &&
        latest?.apiKey === d.apiKey
      )
    }
    try {
      const res = await window.pi.fetchModels({
        profileId: d.id,
        protocol: d.protocol,
        baseUrl: d.baseUrl,
        apiKey: d.apiKey
      })
      if (!isCurrent()) return
      if (res.ok) {
        patchDraft(d.id, { models: res.models, modelsFetchedAt: res.fetchedAt, hasKey: true })
        // 只清理失效的选择，不替用户自动挑一个——模型名由用户自己定
        if (activeIdRef.current === d.id) {
          setModel((cur) => (cur.trim() && res.models.some((m) => m.id === cur) ? cur : ''))
        }
      } else {
        if (res.models.length) patchDraft(d.id, { models: res.models })
        if (activeIdRef.current === d.id) setError(res.error.message)
      }
    } catch (err) {
      if (isCurrent() && activeIdRef.current === d.id) setError((err as Error).message)
    } finally {
      if (request === requestSeq.current) setLoading(false)
    }
  }

  // 切到某个已有凭据的提供商时自动读一次模型列表，省掉手动点
  useEffect(() => {
    const d = drafts[activeId]
    if (!d || d.models.length) return
    if (!hasCredential(d)) return
    void loadModels(d)
    // 只在切换提供商时触发；drafts 的其它变化不需要重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  /* ---------------- OpenAI OAuth 登录 ---------------- */

  const [oauthBusy, setOauthBusy] = useState(false)

  /** 拉起浏览器完成 ChatGPT 登录；成功后 token 加密存进档案（主进程完成） */
  const oauthLogin = async (): Promise<void> => {
    if (!active || oauthBusy) return
    setOauthBusy(true)
    setError(null)
    try {
      const res = await window.pi.oauthLogin(active.id)
      patchDraft(active.id, { oauth: { connected: true, account: res.account } })
    } catch (err) {
      setError(cleanIpcError(err))
    } finally {
      setOauthBusy(false)
    }
  }

  const oauthLogout = async (): Promise<void> => {
    if (!active) return
    try {
      await window.pi.oauthLogout(active.id)
      patchDraft(active.id, { oauth: undefined })
    } catch (err) {
      setError(cleanIpcError(err))
    }
  }

  const selectProvider = (id: string): void => {
    requestSeq.current++
    setLoading(false)
    let draft = drafts[id]
    if (!draft) {
      draft = freshDraft(id)
      setDrafts((prev) => ({ ...prev, [id]: draft }))
    }
    setActiveId(id)
    setError(null)
    // 换了提供商，原来选的模型多半不属于它：清空，等用户从候选里重新选
    if (model && !draft.models.some((m) => m.id === model)) setModel('')
  }

  const addCustom = (): void => {
    requestSeq.current++
    setLoading(false)
    const id = `custom-${Date.now().toString(36).slice(-4)}`
    const draft = freshDraft(id, { label: '自定义中转', custom: true })
    setDrafts((prev) => ({ ...prev, [id]: draft }))
    setActiveId(id)
    setModel('')
    setError(null)
  }

  const onBaseUrlChange = (value: string): void => {
    if (!active) return
    requestSeq.current++
    setLoading(false)
    const hit = detectPreset(value)
    patchDraft(active.id, {
      baseUrl: value,
      // 认出来了就顺手校正协议，避免选了 Anthropic 却填 OpenAI 地址
      protocol: hit ? hit.protocol : active.protocol,
      local: hit ? Boolean(hit.local) : isLocalHost(value),
      note: hit?.note ?? active.note
    })
  }

  const providerRows = useMemo<ProviderRow[]>(() => {
    const rows = PRESETS.map((p) => ({
      id: p.id,
      short: p.short,
      desc: p.label,
      protocol: p.protocol,
      baseUrl: drafts[p.id]?.baseUrl || p.baseUrl,
      hasKey: Boolean(drafts[p.id]?.hasKey || drafts[p.id]?.apiKey),
      oauth: Boolean(drafts[p.id]?.oauth?.connected)
    }))
    const extras = Object.values(drafts)
      .filter((d) => d.custom)
      .map((d) => ({
        id: d.id,
        short: d.label,
        desc: '自定义端点',
        protocol: d.protocol,
        baseUrl: d.baseUrl,
        hasKey: Boolean(d.hasKey || d.apiKey),
        oauth: Boolean(d.oauth?.connected)
      }))
    return [...rows, ...extras]
  }, [drafts])

  const buildPatch = (): ProfilePatch[] => Object.values(drafts).map(toPatch)

  return {
    drafts,
    activeId,
    active,
    model,
    setModel,
    loading,
    error,
    detected,
    needsKey,
    providerRows,
    oauthBusy,
    patchDraft,
    selectProvider,
    addCustom,
    onBaseUrlChange,
    loadModels,
    oauthLogin,
    oauthLogout,
    buildPatch
  }
}

export type ModelsApi = ReturnType<typeof useModelDrafts>
