import { useState } from 'react'
import { store, useSlice } from '../../store'

const SAMPLE = `// plugin.json
{ "name": "web-tools", "version": "0.1.0",
  "description": "抓取网页正文", "main": "index.js" }

// index.js
module.exports = {
  instructions: '需要查资料时用 fetch_text。',
  tools: [{
    name: 'fetch_text',
    description: '抓取网页并返回纯文本',
    parameters: { type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'] },
    async run(input, ctx) {
      const res = await fetch(input.url, { signal: ctx.signal })
      return { content: await res.text() }
    }
  }]
}`

export function PluginsTab(): JSX.Element {
  const plugins = useSlice((s) => s.plugins)
  const [repoUrl, setRepoUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const installFromGitHub = async (): Promise<void> => {
    const url = repoUrl.trim()
    if (!url || installing) return
    setInstalling(true)
    setInstallError(null)
    const err = await store.installPluginFromGitHub(url)
    setInstalling(false)
    if (err) setInstallError(err)
    else setRepoUrl('')
  }

  return (
    <>
      <div className="field">
        <label>已安装插件</label>
        {plugins.length ? (
          <div className="plugin-list">
            {plugins.map((p) => (
              <div className={`plugin-item ${p.enabled ? '' : 'off'}`} key={p.id}>
                <div className="plugin-head">
                  <span className="plugin-name">{p.name}</span>
                  <span className="plugin-ver">v{p.version}</span>
                  <button
                    className={`switch ${p.enabled ? 'on' : ''}`}
                    type="button"
                    onClick={() => void store.togglePlugin(p.id, !p.enabled)}
                    title={p.enabled ? '停用' : '启用'}
                  >
                    <span className="switch-thumb" />
                  </button>
                  <button className="link-btn danger" type="button" onClick={() => void store.removePlugin(p.id)}>
                    卸载
                  </button>
                </div>
                <div className="plugin-desc">{p.description || '没有描述'}</div>
                {p.tools.length > 0 && (
                  <div className="plugin-tools">
                    {p.tools.map((t) => (
                      <code key={t}>{t}</code>
                    ))}
                  </div>
                )}
                {p.error && <div className="plugin-error">{p.error}</div>}
              </div>
            ))}
          </div>
        ) : (
          <p className="field-hint">还没有安装插件。插件可以给代理加新工具或补充提示词。</p>
        )}

        <div className="plugin-actions">
          <button className="btn-ghost small" type="button" onClick={() => void store.installPlugin('file')}>
            安装插件文件…
          </button>
          <button className="btn-ghost small" type="button" onClick={() => void store.installPlugin('dir')}>
            安装插件目录…
          </button>
          <button className="link-btn" type="button" onClick={() => void store.reloadPlugins()}>
            重新加载
          </button>
          <button className="link-btn" type="button" onClick={() => void store.openPluginsDir()}>
            打开插件目录
          </button>
        </div>
      </div>

      <div className="field">
        <label>从 GitHub 安装</label>
        <div className="plugin-github">
          <input
            value={repoUrl}
            placeholder="https://github.com/owner/repo"
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void installFromGitHub()
            }}
            spellCheck={false}
          />
          <button
            className="btn-ghost small"
            type="button"
            disabled={installing || !repoUrl.trim()}
            onClick={() => void installFromGitHub()}
          >
            {installing ? '安装中…' : '安装'}
          </button>
        </div>
        <p className={`field-hint ${installError ? 'err' : ''}`}>
          {installError ?? '支持仓库根地址，也支持 /tree/分支/子目录 定位子包。默认取默认分支，仓库里需要有 plugin.json。'}
        </p>
      </div>

      <div className="field">
        <label>插件怎么写</label>
        <p className="field-hint">
          插件是本地 JS 代码，安装后由主进程加载——<strong>安装即等于在你的机器上执行它</strong>，只装可信来源。
          它可以用 <code>tools</code> 注册新工具（同样受工作目录守卫约束），也可以用 <code>instructions</code> 给模型补充说明。
        </p>
        <pre className="plugin-sample">{SAMPLE}</pre>
      </div>
    </>
  )
}
