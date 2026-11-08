import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublicConfig, ShellKind } from '@shared/types'
import { store } from '../store'
import { useModelDrafts } from './settings/useModelDrafts'
import { GeneralTab } from './settings/GeneralTab'
import { ModelsTab } from './settings/ModelsTab'
import { PluginsTab } from './settings/PluginsTab'
import { RuntimeTab, type RuntimeValues } from './settings/RuntimeTab'
import { SchedulesTab } from './settings/SchedulesTab'

type Tab = 'general' | 'models' | 'plugins' | 'runtime' | 'schedules'

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: '通用' },
  { id: 'models', label: '模型服务' },
  { id: 'plugins', label: '插件' },
  { id: 'runtime', label: '运行' },
  { id: 'schedules', label: '自动化' }
]

function validateRuntime(values: RuntimeValues): string | null {
  const temperature = Number(values.temperature)
  if (!values.temperature.trim() || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    return 'Temperature 需为 0–2 之间的数值'
  }
  const maxSteps = Number(values.maxSteps)
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) {
    return '单轮最大步数需为 1–200 之间的整数'
  }
  const maxTokens = Number(values.maxTokens)
  if (!values.maxTokens.trim() || !Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 200000) {
    return '输出上限需为 0–200000 之间的整数'
  }
  return null
}

/**
 * 设置面板外壳：只管页签、运行参数与保存。
 * 模型服务的复杂状态在 useModelDrafts 里，各页签各自渲染自己的内容。
 */
export function SettingsDialog({ config, onClose }: { config: PublicConfig; onClose: () => void }): JSX.Element {
  const [tab, setTab] = useState<Tab>('models')
  const [saving, setSaving] = useState(false)
  const [runtime, setRuntime] = useState<RuntimeValues>({
    temperature: String(config.temperature),
    maxSteps: String(config.maxSteps),
    maxTokens: String(config.maxTokens),
    shell: config.shell,
    thinking: config.thinking
  })

  const api = useModelDrafts(config)
  const validationError = validateRuntime(runtime)
  const snapshot = JSON.stringify({
    activeProfileId: api.activeId,
    model: api.model.trim(),
    profiles: Object.values(api.drafts).map((d) => ({
      id: d.id,
      label: d.label,
      protocol: d.protocol,
      baseUrl: d.baseUrl,
      apiKey: d.apiKey || undefined,
      clearKey: Boolean(d.clearKey),
      custom: d.custom
    })),
    runtime
  })
  const initialSnapshot = useRef(snapshot)
  const dirty = initialSnapshot.current !== snapshot
  const dialogRef = useRef<HTMLDivElement>(null)
  const canSave = Boolean(api.active?.baseUrl.trim() && api.model.trim() && !validationError && !saving)

  const requestClose = useCallback((): void => {
    if (!dirty || window.confirm('设置尚未保存，确定放弃修改并关闭吗？')) onClose()
  }, [dirty, onClose])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('.dialog-close')?.focus())
    return () => {
      cancelAnimationFrame(frame)
      previous?.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 模型下拉展开时 Esc 先关下拉，别把整个面板关了
      if (e.key === 'Escape') {
        if (!document.querySelector('.model-panel')) {
          e.preventDefault()
          requestClose()
        }
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null)
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  const save = async (): Promise<void> => {
    if (!api.active || validationError) return
    setSaving(true)
    const ok = await store.saveConfig({
      activeProfileId: api.activeId,
      profiles: api.buildPatch(),
      model: api.model.trim(),
      temperature: Number(runtime.temperature),
      maxSteps: Number(runtime.maxSteps),
      maxTokens: Number(runtime.maxTokens) || 0,
      shell: runtime.shell as ShellKind,
      thinking: runtime.thinking
    })
    if (!ok) setSaving(false)
  }

  if (!api.active) return <></>

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div ref={dialogRef} className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-head">
          <span id="settings-title">设置</span>
          <button className="dialog-close" type="button" onClick={requestClose} title="关闭" aria-label="关闭设置">
            ×
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav">
            {TABS.map((t) => (
              <button key={t.id} type="button" className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {tab === 'general' && <GeneralTab />}
            {tab === 'models' && <ModelsTab api={api} />}
            {tab === 'plugins' && <PluginsTab />}
            {tab === 'runtime' && <RuntimeTab values={runtime} onChange={(p) => setRuntime((v) => ({ ...v, ...p }))} />}
            {tab === 'schedules' && <SchedulesTab />}
          </div>
        </div>

        {/* 插件与自动化页的操作即时生效，没有"未保存"状态 */}
        <div className={`dialog-foot ${tab === 'plugins' || tab === 'schedules' ? 'hidden' : ''}`}>
          <span className="foot-note" role="status">
            {validationError ||
              (!api.model.trim()
                ? '还没有选择模型，选完才能保存'
                : api.needsKey
                  ? '当前提供商未配置 Key，保存后仍无法发起请求'
                  : '')}
          </span>
          <button className="btn-ghost" type="button" onClick={requestClose}>
            取消
          </button>
          <button className="btn-primary" type="button" disabled={!canSave} onClick={() => void save()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
