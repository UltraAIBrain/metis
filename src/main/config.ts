import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type {
  ConfigPatch,
  ModelOption,
  ProfilePatch,
  Protocol,
  PublicConfig,
  PublicProfile,
  ShellKind,
  ThinkingEffort
} from '@shared/types'
import { PRESETS, presetById } from '../shared/providers'
import { paths } from './paths'
import { logger } from './logger'

/** 由主进程注入系统级加解密能力（Electron safeStorage）；纯 Node 环境退化为 base64 + 标记。 */
export interface SecretBox {
  available: boolean
  encrypt(plain: string): string
  decrypt(cipher: string): string
}

export const fallbackSecretBox: SecretBox = {
  available: false,
  encrypt: (p) => `plain:${Buffer.from(p, 'utf8').toString('base64')}`,
  decrypt: (c) => {
    // enc: 是桌面版 safeStorage 的密文，终端版解不开；返回空让上层回落环境变量并记日志
    if (c.startsWith('enc:')) return ''
    return c.startsWith('plain:') ? Buffer.from(c.slice(6), 'base64').toString('utf8') : ''
  }
}

export interface StoredProfile {
  id: string
  label: string
  protocol: Protocol
  baseUrl: string
  apiKey?: string
  keyProtected?: boolean
  /** OAuth 凭据（SecretBox 加密的 JSON 串：access/refresh token + 过期时间 + 账号） */
  oauth?: string
  models?: ModelOption[]
  modelsFetchedAt?: number
}

export interface StoredConfig {
  version: 2
  /** 上次选过的目录，只用来当选择器的默认位置；真正的工作目录在会话上 */
  lastCwd: string
  activeProfileId: string
  profiles: StoredProfile[]
  model: string
  temperature: number
  maxTokens: number
  shell: ShellKind
  /** 思考强度，见 ThinkingEffort */
  thinking: ThinkingEffort
  lastSessionId?: string
  window?: { width: number; height: number; x?: number; y?: number; maximized?: boolean }
}

/** v1 的旧结构，仅用于迁移 */
interface LegacyConfig {
  version?: number
  workspace?: string
  provider?: Protocol
  model?: string
  temperature?: number
  shell?: ShellKind
  providers?: Record<Protocol, { baseUrl?: string; apiKey?: string; keyProtected?: boolean }>
  lastSessionId?: string
  window?: StoredConfig['window']
}

const ENV_KEY: Record<Protocol, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  responses: 'OPENAI_API_KEY'
}

const PROTOCOLS: Protocol[] = ['openai', 'anthropic', 'responses']

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min
}

export class ConfigStore {
  private cache: StoredConfig | null = null
  private existedAtLoad = false

  constructor(private box: SecretBox = fallbackSecretBox, private file = paths.config()) {}

  load(): StoredConfig {
    if (this.cache) return this.cache
    this.existedAtLoad = existsSync(this.file)
    if (!this.existedAtLoad) {
      this.cache = this.defaults()
      return this.cache
    }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as StoredConfig & LegacyConfig
      this.cache = this.normalize(raw)
    } catch (err) {
      logger.error('config.parse_failed', err)
      this.cache = this.defaults()
    }
    return this.cache
  }

  private defaults(): StoredConfig {
    // 默认档案固定用 kimi：PRESETS[0] 是 openai-codex（要 OAuth 登录才能用），不适合做开箱默认
    const first = presetById('kimi') ?? PRESETS[0]
    return {
      version: 2,
      lastCwd: '',
      activeProfileId: first.id,
      profiles: [
        {
          id: first.id,
          label: first.label,
          protocol: first.protocol,
          baseUrl: first.baseUrl,
          models: []
        }
      ],
      // 模型不预置：由用户在启动后从 /models 候选里选
      model: '',
      temperature: 0.2,
      // 0 = 自动跟随模型自身的输出上限（见 shared/model-catalog）
      maxTokens: 0,
      shell: 'auto',
      // GLM-5.x 的服务端默认是 max，这里取 high 更省时延，用户可在「运行」里改
      thinking: 'high'
    }
  }

  /** v1（openai / anthropic 两个协议槽位）→ v2（按提供商建档）。 */
  private migrateLegacy(raw: LegacyConfig): StoredProfile[] {
    const profiles: StoredProfile[] = []
    const legacy = raw.providers
    const wanted: Array<'openai' | 'anthropic'> = ['openai', 'anthropic']
    const legacyBase: Record<'openai' | 'anthropic', string> = {
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com'
    }

    for (const protocol of wanted) {
      const entry = legacy?.[protocol]
      // 没有 Key 的槽位没有保留价值；有 Key 的按自定义档案保下来，不丢凭据
      if (!entry?.apiKey) continue
      profiles.push({
        id: protocol,
        label: presetById(protocol)?.label ?? (protocol === 'anthropic' ? 'Anthropic Claude' : 'OpenAI'),
        protocol,
        baseUrl: entry.baseUrl || legacyBase[protocol],
        apiKey: entry.apiKey,
        keyProtected: entry.keyProtected,
        models: []
      })
    }

    if (!profiles.length) {
      const first = presetById('kimi') ?? PRESETS[0]
      profiles.push({
        id: first.id,
        label: first.label,
        protocol: first.protocol,
        baseUrl: first.baseUrl,
        models: []
      })
    }
    return profiles
  }

  private normalize(raw: StoredConfig & LegacyConfig): StoredConfig {
    const d = this.defaults()
    const isV2 = raw.version === 2 && Array.isArray(raw.profiles) && raw.profiles.length > 0
    const profiles: StoredProfile[] = isV2
      ? (raw.profiles as StoredProfile[]).map((p) => ({
          id: String(p.id || 'custom'),
          label: String(p.label || presetById(p.id)?.label || p.id || '自定义'),
          protocol: PROTOCOLS.includes(p.protocol) ? p.protocol : 'openai',
          baseUrl: String(p.baseUrl || ''),
          apiKey: p.apiKey,
          keyProtected: p.keyProtected,
          oauth: p.oauth,
          models: Array.isArray(p.models) ? p.models.slice(0, 500) : [],
          modelsFetchedAt: typeof p.modelsFetchedAt === 'number' ? p.modelsFetchedAt : undefined
        }))
      : this.migrateLegacy(raw)

    const activeId =
      isV2 && raw.activeProfileId && profiles.some((p) => p.id === raw.activeProfileId)
        ? raw.activeProfileId
        : profiles[0].id

    const shell: ShellKind = (['auto', 'powershell', 'cmd', 'bash'] as ShellKind[]).includes(raw.shell as ShellKind)
      ? (raw.shell as ShellKind)
      : 'auto'

    const active = profiles.find((p) => p.id === activeId) ?? profiles[0]

    return {
      version: 2,
      lastCwd:
        typeof raw.lastCwd === 'string' && raw.lastCwd
          ? raw.lastCwd
          : typeof raw.workspace === 'string'
            ? raw.workspace
            : d.lastCwd,
      activeProfileId: active.id,
      profiles,
      model: typeof raw.model === 'string' && raw.model ? raw.model : (active.models?.[0]?.id ?? d.model),
      temperature: clamp(Number(raw.temperature ?? d.temperature), 0, 2),
      maxTokens: Math.round(clamp(Number(raw.maxTokens ?? d.maxTokens), 0, 200000)),
      shell,
      thinking: (['low', 'high', 'max'] as ThinkingEffort[]).includes(raw.thinking as ThinkingEffort)
        ? (raw.thinking as ThinkingEffort)
        : d.thinking,
      lastSessionId: typeof raw.lastSessionId === 'string' ? raw.lastSessionId : undefined,
      window: raw.window
    }
  }

  save(): void {
    const cfg = this.load()
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
      renameSync(tmp, this.file) // 原子替换，避免半截文件
      this.existedAtLoad = true
    } catch (err) {
      // 写失败时丢弃内存缓存：cache 里的 cfg 已被就地修改，保留会让内存与磁盘持续不一致
      this.cache = null
      logger.error('config.write_failed', err)
      throw new Error('配置保存失败，请检查磁盘权限')
    }
  }

  activeProfile(): StoredProfile {
    const cfg = this.load()
    return cfg.profiles.find((p) => p.id === cfg.activeProfileId) ?? cfg.profiles[0]
  }

  profileById(id: string): StoredProfile | undefined {
    return this.load().profiles.find((p) => p.id === id)
  }

  patch(p: ConfigPatch): StoredConfig {
    const cfg = this.load()

    if (p.temperature !== undefined) {
      const value = Number(p.temperature)
      if (!Number.isFinite(value)) throw new Error('Temperature 必须是有限数值')
      cfg.temperature = clamp(value, 0, 2)
    }
    if (p.shell && (['auto', 'powershell', 'cmd', 'bash'] as ShellKind[]).includes(p.shell)) cfg.shell = p.shell
    if (p.thinking && (['low', 'high', 'max'] as ThinkingEffort[]).includes(p.thinking)) cfg.thinking = p.thinking
    if (p.maxTokens !== undefined) {
      const value = Number(p.maxTokens)
      if (!Number.isFinite(value)) throw new Error('输出上限必须是有限数值')
      cfg.maxTokens = Math.round(clamp(value, 0, 200000))
    }

    if (Array.isArray(p.profiles)) {
      for (const patch of p.profiles) this.applyProfilePatch(cfg, patch)
    }

    if (typeof p.activeProfileId === 'string' && cfg.profiles.some((x) => x.id === p.activeProfileId)) {
      // 切换厂商时若没有显式给模型，旧模型名大概率不属于新厂商，清掉让用户重选
      if (cfg.activeProfileId !== p.activeProfileId && p.model === undefined) {
        const next = cfg.profiles.find((x) => x.id === p.activeProfileId)
        cfg.model = next?.models?.[0]?.id ?? ''
      }
      cfg.activeProfileId = p.activeProfileId
    }
    if (typeof p.model === 'string' && p.model.trim()) cfg.model = p.model.trim()

    if (!cfg.profiles.length) cfg.profiles = this.defaults().profiles
    if (!cfg.profiles.some((x) => x.id === cfg.activeProfileId)) cfg.activeProfileId = cfg.profiles[0].id

    this.save()
    logger.info('config.updated', {
      active: cfg.activeProfileId,
      model: cfg.model,
      shell: cfg.shell,
      profiles: cfg.profiles.length
    })
    return cfg
  }

  /** 记住最近用过的目录，下次选目录时从这里开始 */
  setLastCwd(dir: string): void {
    const cfg = this.load()
    if (!dir || cfg.lastCwd === dir) return
    cfg.lastCwd = dir
    this.save()
  }

  private applyProfilePatch(cfg: StoredConfig, patch: ProfilePatch): void {
    const id = String(patch.id || '').trim()
    if (!id) return
    const preset = presetById(id)
    let profile = cfg.profiles.find((x) => x.id === id)

    if (!profile) {
      profile = {
        id,
        label: preset?.label ?? id,
        protocol: preset?.protocol ?? 'openai',
        baseUrl: preset?.baseUrl ?? '',
        models: []
      }
      cfg.profiles.push(profile)
    }

    if (typeof patch.label === 'string' && patch.label.trim()) profile.label = patch.label.trim()
    if (patch.protocol && PROTOCOLS.includes(patch.protocol)) profile.protocol = patch.protocol
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) {
      profile.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '')
    }
    if (Array.isArray(patch.models)) {
      profile.models = patch.models.slice(0, 500)
      profile.modelsFetchedAt = patch.modelsFetchedAt ?? Date.now()
    }

    if (patch.clearKey) {
      delete profile.apiKey
      delete profile.keyProtected
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      profile.apiKey = this.box.encrypt(patch.apiKey.trim())
      profile.keyProtected = this.box.available
    }
  }

  /** 取明文 key：优先该档案本地存储，其次对应协议的环境变量。仅主进程可见。 */
  apiKeyFor(profileId: string): { key: string; source: 'stored' | 'env' | 'none' } {
    const profile = this.profileById(profileId) ?? this.activeProfile()
    if (profile?.apiKey) {
      try {
        const key = this.box.decrypt(profile.apiKey)
        if (key) return { key, source: 'stored' }
        if (profile.apiKey.startsWith('enc:')) {
          logger.warn('config.key_unreadable_here', {
            profileId,
            reason: 'key was encrypted by the desktop safeStorage and cannot be decrypted in this environment'
          })
        }
      } catch (err) {
        logger.warn('config.decrypt_failed', err)
      }
    }
    const env = process.env[ENV_KEY[profile?.protocol ?? 'openai']]
    if (env) return { key: env, source: 'env' }
    return { key: '', source: 'none' }
  }

  saveModels(profileId: string, models: ModelOption[]): void {
    const profile = this.profileById(profileId)
    if (!profile) return
    profile.models = models.slice(0, 500)
    profile.modelsFetchedAt = Date.now()
    this.save()
  }

  /** 存 OAuth 凭据（整体加密成一个 JSON 串；access/refresh token 都不出主进程明文） */
  setOAuth(profileId: string, tokens: { accessToken: string; refreshToken: string; expiresAt?: number; account?: string }): void {
    const profile = this.profileById(profileId)
    if (!profile) throw new Error(`档案不存在：${profileId}`)
    profile.oauth = this.box.encrypt(JSON.stringify(tokens))
    this.save()
  }

  clearOAuth(profileId: string): void {
    const profile = this.profileById(profileId)
    if (!profile) return
    delete profile.oauth
    this.save()
  }

  /** 取解密后的 OAuth 凭据；损坏 / 解不开时返回 null（不抛，让上层回落重新登录） */
  oauthFor(profileId: string): { accessToken: string; refreshToken: string; expiresAt?: number; account?: string } | null {
    const profile = this.profileById(profileId)
    if (!profile?.oauth) return null
    try {
      const raw = this.box.decrypt(profile.oauth)
      const parsed = JSON.parse(raw) as { accessToken?: string; refreshToken?: string; expiresAt?: number; account?: string }
      if (!parsed.refreshToken) return null
      return {
        accessToken: parsed.accessToken ?? '',
        refreshToken: parsed.refreshToken,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
        account: parsed.account
      }
    } catch (err) {
      logger.warn('config.oauth_unreadable', { profileId, message: (err as Error).message })
      return null
    }
  }

  setLastSession(id: string | undefined): void {
    const cfg = this.load()
    if (cfg.lastSessionId === id) return
    cfg.lastSessionId = id
    this.save()
  }

  setWindowState(w: StoredConfig['window']): void {
    const cfg = this.load()
    cfg.window = w
    this.save()
  }

  toPublic(): PublicConfig {
    const cfg = this.load()
    return {
      lastCwd: cfg.lastCwd,
      activeProfileId: cfg.activeProfileId,
      profiles: cfg.profiles.map((p): PublicProfile => {
        const k = this.apiKeyFor(p.id)
        const oauth = this.oauthFor(p.id)
        return {
          id: p.id,
          label: p.label,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          hasKey: k.source !== 'none',
          keyProtected: Boolean(p.keyProtected),
          oauth: oauth ? { connected: true, account: oauth.account } : undefined,
          models: p.models ?? [],
          modelsFetchedAt: p.modelsFetchedAt
        }
      }),
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      shell: cfg.shell,
      thinking: cfg.thinking,
      lastSessionId: cfg.lastSessionId
    }
  }
}
