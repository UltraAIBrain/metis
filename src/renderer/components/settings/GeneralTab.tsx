import { hasStarted } from '../../util'
import { store, useSlice } from '../../store'

export function GeneralTab(): JSX.Element {
  const session = useSlice((s) => s.session)
  const app = useSlice((s) => s.app)
  const started = hasStarted(session)

  return (
    <>
      <div className="field">
        <label>项目目录</label>
        {session ? (
          <>
            <div className="inline-row">
              <input
                value={session.cwd}
                readOnly
                title={session.cwd || '首次运行时自动创建'}
                placeholder="首次发送消息时自动创建"
              />
              <button className="btn-ghost" type="button" disabled={started} onClick={() => void store.changeCwd()}>
                指定…
              </button>
            </div>
            <p className="field-hint">
              {started
                ? '会话已开始，目录已锁定。需要换目录请新建项目。'
                : session.cwd
                  ? '读写类工具被限制在这个目录内；bash 命令不受此限制。会话开始后不可更改。'
                  : '还没指定目录。发送第一条消息时会在 ~/.pidesktop/projects 下自动建一个，也可以现在指定。'}
            </p>
          </>
        ) : (
          <p className="field-hint">还没有打开项目。关掉设置后点「新建项目」即可。</p>
        )}
      </div>

      <div className="field">
        <label>数据</label>
        <div className="kv">
          <span>配置与会话</span>
          <code title={app?.dataDir}>{app?.dataDir ?? '—'}</code>
        </div>
        <div className="kv">
          <span>全局记忆</span>
          <code title="模型通过 memory 工具跨会话维护的持久记忆">
            {app ? `${app.dataDir}\\MEMORY.md` : '—'}
          </code>
        </div>
        <div className="kv">
          <span>人格文件</span>
          <code title="存在即注入 system prompt：自定义口吻、称呼与风格">{app ? `${app.dataDir}\\SOUL.md` : '—'}</code>
        </div>
        <div className="kv">
          <span>运行日志</span>
          <code title={app?.logsDir}>{app?.logsDir ?? '—'}</code>
        </div>
        <p className="field-hint">
          日志按天轮转，保留 7 天。
          <button className="link-btn" type="button" onClick={() => void store.openLogs()}>
            打开日志目录
          </button>
          {' · '}
          <button
            className="link-btn"
            type="button"
            title="SOUL.md 存在即注入每次对话：定义口吻、称呼、回复风格；留空则用默认风格"
            onClick={() => void store.editSoul()}
          >
            编辑人格文件
          </button>
        </p>
      </div>
    </>
  )
}
