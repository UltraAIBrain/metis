import type { ShellKind, ThinkingEffort } from '@shared/types'

export interface RuntimeValues {
  temperature: string
  maxSteps: string
  maxTokens: string
  shell: ShellKind
  thinking: ThinkingEffort
}

const LEVELS: { id: ThinkingEffort; label: string; hint: string }[] = [
  { id: 'low', label: '低', hint: '快，少花 token' },
  { id: 'high', label: '高', hint: '速度与深度平衡' },
  { id: 'max', label: '极致', hint: '最深推理，最慢' }
]

export function RuntimeTab({
  values,
  onChange
}: {
  values: RuntimeValues
  onChange: (patch: Partial<RuntimeValues>) => void
}): JSX.Element {
  return (
    <>
      <div className="field">
        <label>默认思考强度</label>
        <div className="choice-row">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              className={`choice ${values.thinking === l.id ? 'active' : ''}`}
              onClick={() => onChange({ thinking: l.id })}
            >
              <span className="choice-label">{l.label}</span>
              <span className="choice-hint">{l.hint}</span>
            </button>
          ))}
        </div>
        <p className="field-hint">
          新会话的默认值；在会话顶栏可以单独覆盖。对应 <code>reasoning_effort</code>（GLM-5.x / GPT-5.x / o 系列）或{' '}
          <code>output_config.effort</code>（Claude 5.x），不支持该参数的模型会自动忽略。
        </p>
      </div>

      <div className="field-grid">
        <div className="field">
          <label>Temperature</label>
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={values.temperature}
            onChange={(e) => onChange({ temperature: e.target.value })}
          />
          <p className="field-hint">0 最稳定，越高越发散。</p>
        </div>
        <div className="field">
          <label>输出上限</label>
          <input
            type="number"
            min={0}
            max={200000}
            step={1024}
            value={values.maxTokens}
            onChange={(e) => onChange({ maxTokens: e.target.value })}
          />
          <p className="field-hint">0 = 自动跟随模型上限；思考也计入这里。</p>
        </div>
        <div className="field">
          <label>单轮最大步数</label>
          <input
            type="number"
            min={1}
            max={200}
            value={values.maxSteps}
            onChange={(e) => onChange({ maxSteps: e.target.value })}
          />
          <p className="field-hint">一次任务里最多几步工具往返。</p>
        </div>
      </div>

      <div className="field">
        <label>Shell</label>
        <select value={values.shell} onChange={(e) => onChange({ shell: e.target.value as ShellKind })}>
          <option value="auto">自动（Windows 用 PowerShell）</option>
          <option value="powershell">PowerShell</option>
          <option value="cmd">cmd.exe</option>
          <option value="bash">bash</option>
        </select>
        <p className="field-hint">bash 工具通过它执行命令；改错会导致命令失败。</p>
      </div>
    </>
  )
}
