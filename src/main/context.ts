import { safeStorage } from 'electron'
import type { AgentEvent } from '@shared/types'
import { ConfigStore, fallbackSecretBox, type SecretBox } from './config'
import { SessionStore } from './agent/session'
import { AgentRunner } from './agent/runner'
import { logger } from './logger'
import { paths } from './paths'

/** 用系统密钥链加密 API Key；不可用时退化为本地混淆并如实标记。 */
function createSecretBox(): SecretBox {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        available: true,
        encrypt: (plain) => `enc:${safeStorage.encryptString(plain).toString('base64')}`,
        decrypt: (cipher) => {
          // 兼容早期或降级模式下写入的 plain: 值，否则这些 key 会永久读不出来
          if (cipher.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(cipher.slice(4), 'base64'))
          if (cipher.startsWith('plain:')) return Buffer.from(cipher.slice(6), 'base64').toString('utf8')
          return ''
        }
      }
    }
  } catch (err) {
    logger.warn('safeStorage.unavailable', err)
  }
  return fallbackSecretBox
}

export class AppContext {
  readonly config: ConfigStore
  readonly sessions: SessionStore
  readonly runner: AgentRunner
  private emitter: (event: AgentEvent) => void = () => {}

  constructor() {
    this.config = new ConfigStore(createSecretBox(), paths.config())
    this.sessions = new SessionStore(paths.sessions())
    this.runner = new AgentRunner(this.sessions, this.config, logger, (event) => this.emit(event))
  }

  bind(fn: (event: AgentEvent) => void): void {
    this.emitter = fn
  }

  emit(event: AgentEvent): void {
    try {
      this.emitter(event)
    } catch (err) {
      logger.warn('event.emit_failed', err)
    }
  }
}

let instance: AppContext | null = null

export function context(): AppContext {
  if (!instance) instance = new AppContext()
  return instance
}
