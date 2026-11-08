import { describeInputs, formatTokens, lookupModel } from '@shared/model-catalog'
import type { ModelsApi } from './useModelDrafts'
import { ModelPicker } from './ModelPicker'
import { freshness } from './draft'

export function ModelsTab({ api }: { api: ModelsApi }): JSX.Element {
  const { active, activeId, drafts, model, setModel, loading, error, detected, needsKey, oauthBusy } = api
  if (!active) return <></>

  // 选中模型的参数：接口返回的优先，其次内置表
  const picked = active.models.find((m) => m.id === model)
  const fallback = model ? lookupModel(model) : undefined
  const meta = picked ?? fallback
  const metaSource = picked?.metaSource ?? (fallback ? 'catalog' : undefined)
  const protoName = active.protocol === 'anthropic' ? 'Anthropic' : active.protocol === 'responses' ? 'Responses' : 'OpenAI'

  return (
    <>
      <div className="field">
        <label>提供商</label>
        <div className="provider-list">
          {api.providerRows.map((r) => (
            <button
              type="button"
              key={r.id}
              className={`provider-item ${r.id === activeId ? 'active' : ''}`}
              onClick={() => api.selectProvider(r.id)}
            >
              <span className="provider-item-main">
                <span className="provider-item-id">{r.short}</span>
                <span className={`protocol-tag ${r.protocol}`}>
                  {r.protocol === 'anthropic' ? 'Anthropic' : r.protocol === 'responses' ? 'Responses' : 'OpenAI'}
                </span>
                {(r.hasKey || r.oauth) && <span className="provider-item-key">{r.oauth ? '已登录' : '已配置'}</span>}
              </span>
              <span className="provider-item-desc">
                {r.desc}
                {r.baseUrl ? ` · ${r.baseUrl.replace(/^https?:\/\//, '')}` : ''}
              </span>
            </button>
          ))}
          <button type="button" className="provider-item add" onClick={api.addCustom}>
            ＋ 添加自定义端点
          </button>
        </div>
        <p className="field-hint">选中后地址与协议自动填好；模型列表读取后由你自己选。</p>
      </div>

      <div className="field">
        <label>
          Base URL
          <span className={`proto-badge ${active.protocol}`}>{protoName} {active.protocol === 'responses' ? '协议' : '兼容'}</span>
        </label>
        <input
          value={active.baseUrl}
          onChange={(e) => api.onBaseUrlChange(e.target.value)}
          spellCheck={false}
          placeholder="https://api.example.com/v1"
        />
        {detected ? (
          <p className="field-hint ok">
            已识别为 {detected.label}
            {detected.note ? ` · ${detected.note}` : ''}
          </p>
        ) : active.baseUrl.trim() ? (
          <p className="field-hint">未匹配预设，按 {protoName} 协议调用。</p>
        ) : (
          <p className="field-hint">不填协议前缀时按 OpenAI 兼容处理。</p>
        )}
      </div>

      {/* Responses 协议（ChatGPT 登录）：OAuth 优先；其余协议显示 API Key */}
      {active.protocol === 'responses' ? (
        <div className="field">
          <label>
            OpenAI 登录
            <span className="proto-badge responses">ChatGPT 订阅</span>
          </label>
          {active.oauth?.connected ? (
            <div className="oauth-row">
              <span className="oauth-account" title={active.oauth.account}>
                已登录{active.oauth.account ? ` · ${active.oauth.account}` : ''}
              </span>
              <button className="link-btn" type="button" onClick={() => void api.oauthLogout()}>
                退出登录
              </button>
            </div>
          ) : (
            <button className="oauth-login-btn" type="button" disabled={oauthBusy} onClick={() => void api.oauthLogin()}>
              {oauthBusy ? '等待浏览器完成登录…' : '用 ChatGPT 账号登录'}
            </button>
          )}
          <p className="field-hint">
            OAuth（PKCE）登录，token 加密保存在本机、过期自动续期；不用填 API Key。
            {oauthBusy && ' 浏览器窗口已打开，完成后这里会自动更新。'}
          </p>
        </div>
      ) : (
        <div className="field">
          <label>
            API Key
            {active.local && <span className="proto-badge local">本地服务可留空</span>}
          </label>
          <input
            type="password"
            value={active.apiKey ?? ''}
            onChange={(e) => api.patchDraft(active.id, { apiKey: e.target.value, clearKey: false })}
            placeholder={active.hasKey ? '已保存（留空表示不修改）' : needsKey ? '未配置，请填写' : '可留空'}
            spellCheck={false}
          />
          <p className="field-hint">
            {active.hasKey ? '已加密保存在本机，仅主进程可读。' : '也可用环境变量 OPENAI_API_KEY / ANTHROPIC_API_KEY 兜底。'}
            {active.hasKey && (
              <button
                className="link-btn"
                type="button"
                onClick={() => api.patchDraft(active.id, { clearKey: !active.clearKey })}
              >
                {active.clearKey ? '将清除（保存后生效）' : '清除'}
              </button>
            )}
          </p>
        </div>
      )}

      <div className="field">
        <label>默认模型</label>
        <ModelPicker
          value={model}
          options={active.models}
          loading={loading}
          onChange={setModel}
          onRefresh={() => void api.loadModels()}
        />
        <p className={`field-hint ${error ? 'err' : ''}`}>
          {error
            ? error
            : !active.models.length
              ? '还没有候选：点「读取」从服务商接口拉取，或直接手填模型名。'
              : model
                ? `${active.models.length} 个候选 · ${freshness(active.modelsFetchedAt)} · 默认用于新会话，已有会话可在顶栏单独切换`
                : `已读取 ${active.models.length} 个候选，请选择一个模型`}
        </p>

        {model && (
          <div className="model-meta">
            <span>
              <i>上下文</i>
              <b>{formatTokens(meta?.contextWindow)}</b>
            </span>
            <span>
              <i>最大输出</i>
              <b>{meta?.maxOutput ? meta.maxOutput.toLocaleString() : '未知'}</b>
            </span>
            <span>
              <i>输入</i>
              <b>{describeInputs(meta?.inputs)}</b>
            </span>
            <span className="model-meta-src">{metaSource === 'api' ? '接口读取' : metaSource === 'catalog' ? '内置表' : '未知'}</span>
          </div>
        )}
      </div>

      {Object.keys(drafts).length === 0 && <p className="field-hint">还没有任何提供商档案，先选一个上面的条目。</p>}
    </>
  )
}
