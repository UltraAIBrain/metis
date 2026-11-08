import { useEffect, useState } from 'react'
import type { ScheduleTask } from '@shared/types'
import { useSlice } from '../../store'

/**
 * 定时任务管理：到点把一条 prompt 注入指定会话（会话在跑就是 steering 排队）。
 * cron 为本地时区 5 段（分 时 日 月 周），常用预置一键填入。
 */

const PRESETS: { label: string; cron: string }[] = [
  { label: '每天 09:00', cron: '0 9 * * *' },
  { label: '工作日 09:00', cron: '0 9 * * 1-5' },
  { label: '每小时', cron: '0 * * * *' },
  { label: '每 15 分钟', cron: '*/15 * * * *' }
]

export function SchedulesTab(): JSX.Element {
  const sessions = useSlice((s) => s.sessions)
  const [tasks, setTasks] = useState<ScheduleTask[]>([])
  const [name, setName] = useState('')
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async (): Promise<void> => {
    try {
      setTasks(await window.pi.listSchedules())
    } catch {
      setTasks([])
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  useEffect(() => {
    if (!sessionId && sessions.length) setSessionId(sessions[0].id)
  }, [sessions])

  const submit = async (): Promise<void> => {
    if (!name.trim() || !prompt.trim() || !sessionId || busy) return
    setBusy(true)
    setError(null)
    try {
      await window.pi.createSchedule({ name, cron, prompt, sessionId })
      setName('')
      setPrompt('')
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (t: ScheduleTask): Promise<void> => {
    try {
      await window.pi.updateSchedule(t.id, { enabled: !t.enabled })
      await reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const remove = async (t: ScheduleTask): Promise<void> => {
    try {
      await window.pi.removeSchedule(t.id)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const titleOf = (id: string): string => {
    const s = sessions.find((x) => x.id === id)
    return s ? s.title || '未命名会话' : id
  }

  return (
    <>
      {tasks.length > 0 && (
        <div className="field">
          <label>已启用的任务（{tasks.length}）</label>
          <div className="schedule-list">
            {tasks.map((t) => (
              <div key={t.id} className={`schedule-row ${t.enabled ? '' : 'off'}`}>
                <div className="schedule-main">
                  <span className="schedule-name" title={`${t.name} · ${t.cron}`}>
                    {t.name}
                  </span>
                  <span className="schedule-cron">{t.cron}</span>
                </div>
                <span className="schedule-target" title={t.prompt}>
                  → {titleOf(t.sessionId)}
                </span>
                <button className="link-btn" type="button" onClick={() => void toggle(t)}>
                  {t.enabled ? '停用' : '启用'}
                </button>
                <button className="link-btn danger" type="button" onClick={() => void remove(t)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label>新建任务</label>
        <div className="schedule-form">
          <div className="schedule-grid">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="任务名（如：每日站会摘要）" />
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="cron：分 时 日 月 周"
              spellCheck={false}
              className="mono"
            />
          </div>
          <div className="schedule-presets">
            {PRESETS.map((p) => (
              <button key={p.cron} type="button" className={`schedule-preset ${cron === p.cron ? 'on' : ''}`} onClick={() => setCron(p.cron)}>
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="到点要发送的提示词（会在所选会话里执行）"
          />
          <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            {sessions.length === 0 && <option value="">（还没有会话）</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title || '未命名会话'}
              </option>
            ))}
          </select>
          {error && <p className="field-hint err">{error}</p>}
          <button className="btn-primary schedule-add" type="button" disabled={!name.trim() || !prompt.trim() || !sessionId || busy} onClick={() => void submit()}>
            添加定时任务
          </button>
        </div>
        <p className="field-hint">
          到点把提示词注入所选会话：任务在跑就是排队插话，空闲则立即开跑。修改/删除即时生效，无需保存。
        </p>
      </div>
    </>
  )
}
