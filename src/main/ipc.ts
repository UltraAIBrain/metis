import { BrowserWindow, app, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { buildTrajectory } from './trajectory'
import { trajectoryToMarkdown } from './trajectory-md'
import type {
  Bootstrap,
  ConfigPatch,
  ModelListRequest,
  ModelListResult,
  PluginInfo,
  Protocol,
  SendResult,
  SessionSummary,
  SessionView,
  ThinkingEffort,
  Trajectory
} from '@shared/types'
import { IPC } from '@shared/ipc'
import { context } from './context'
import { logger } from './logger'
import { getDataDir, paths } from './paths'
import { listModels } from './models'
import { resolveBearer, startLogin } from './oauth'
import { pluginHost } from './plugins'
import { describeFailure } from './agent/errors'
import { assertSessionId } from './agent/session'
import { answerAsk, bindAskDelivery } from './agent/tools/ask'
import { createSchedule, listSchedules, removeSchedule, updateSchedule, type ScheduleTask } from './scheduler'
import { searchSessions, type SessionSearchHit } from './session-search'
import {
  attachmentLimit,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  pickMime,
  removeSessionAttachments,
  stageAttachment
} from './attachments'
import { changes as workspaceChanges, diffOf, listDir, openFile, openWorkspace, readTextFile, searchFiles } from './workspace'
import { termHost } from './term'
import type { PickedFile, TermShellKind } from '@shared/types'

function validatePatch(raw: unknown): ConfigPatch {
  if (!raw || typeof raw !== 'object') throw new Error('无效的配置参数')
  return raw as ConfigPatch
}

/** 弹系统目录选择框；取消返回 null，调用方据此决定"什么都不做"。 */
async function pickDirectory(win: BrowserWindow | null, defaultPath?: string): Promise<string | null> {
  const opts: OpenDialogOptions = {
    title: '选择项目目录',
    buttonLabel: '用作项目目录',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath
  }
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/**
 * 所有渲染进程能力都在这里收口：参数校验 → 调用领域逻辑 → 返回纯数据。
 * 渲染进程没有任何 Node/Electron 直接权限。
 */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const ctx = context()

  ipcMain.handle(IPC.bootstrap, (): Bootstrap => {
    return {
      config: ctx.config.toPublic(),
      sessions: ctx.sessions.list(),
      appVersion: app.getVersion(),
      platform: process.platform,
      dataDir: getDataDir(),
      logsDir: paths.logs(),
      running: ctx.runner.runningIds()
    }
  })

  ipcMain.handle(IPC.configSave, (_e, raw: unknown) => {
    const patch = validatePatch(raw)
    ctx.config.patch(patch)
    return ctx.config.toPublic()
  })

  ipcMain.handle(IPC.logsOpen, async () => {
    const dir = paths.logs()
    const err = await shell.openPath(dir)
    if (err) logger.warn('logs.open_failed', err)
    return dir
  })

  /** 打开（必要时创建空模板）用户人格文件 SOUL.md，用系统默认编辑器编辑 */
  ipcMain.handle(IPC.soulEdit, async (): Promise<string> => {
    const file = paths.soul()
    if (!existsSync(file)) {
      try {
        writeFileSync(
          file,
          '# SOUL.md — pi 的人格与口吻（存在即注入 system prompt）\n\n# 示例：\n# - 回答保持简洁，先给结论再给细节\n# - 称呼用户为"老板"\n# - 代码注释用英文\n',
          'utf8'
        )
      } catch (err) {
        logger.warn('soul.create_failed', err)
      }
    }
    const err = await shell.openPath(file)
    if (err) logger.warn('soul.open_failed', { err })
    return file
  })

  ipcMain.handle(IPC.sessionList, () => ctx.sessions.list())

  ipcMain.handle(IPC.sessionLoad, (_e, id: string): SessionView => ctx.sessions.view(id))

  /** 只弹目录选择框，不创建任何东西——新建项目时先把目录存在草稿里 */
  ipcMain.handle(IPC.pickDir, async (): Promise<string | null> => {
    return pickDirectory(getWindow(), ctx.config.load().lastCwd || undefined)
  })

  /**
   * 真正落盘创建会话。渲染层只会在"发送第一条消息"时调用，
   * 所以侧栏不会出现没发过消息的空会话。
   */
  ipcMain.handle(
    IPC.sessionNew,
    (_e, cwd?: string, preset?: { profileId?: string; model?: string; thinking?: ThinkingEffort }): SessionView => {
      const cfg = ctx.config.load()
      const dir = typeof cwd === 'string' ? cwd.trim() : ''
      const profileId =
        preset?.profileId && cfg.profiles.some((p) => p.id === preset.profileId)
          ? preset.profileId
          : cfg.activeProfileId
      const model = preset?.model?.trim() || cfg.model

      const meta = ctx.sessions.create(dir, { profileId, model })
      if (preset?.thinking) ctx.sessions.setThinking(meta.id, preset.thinking)
      if (dir) ctx.config.setLastCwd(dir)
      ctx.config.setLastSession(meta.id)
      logger.info('session.created', { id: meta.id, cwd: dir || '(lazy)' })
      return ctx.sessions.view(meta.id)
    }
  )

  /** 更换某个项目的工作目录；会话一旦开始就不允许再改，避免历史消息的路径失效。 */
  ipcMain.handle(IPC.sessionCwd, async (_e, id: string): Promise<SessionView | null> => {
    if (ctx.sessions.hasStarted(id)) {
      throw new Error('会话已经开始，目录不可更改。需要换目录请新建项目。')
    }
    const current = ctx.sessions.view(id)
    const dir = await pickDirectory(getWindow(), current.cwd || ctx.config.load().lastCwd || undefined)
    if (!dir) return null

    ctx.sessions.setCwd(id, dir)
    ctx.config.setLastCwd(dir)
    logger.info('session.cwd_changed', { id, cwd: dir })
    return ctx.sessions.view(id)
  })

  ipcMain.handle(IPC.sessionModel, (_e, rawId: string, profileId: string, model: string): SessionView => {
    const id = assertSessionId(rawId)
    const profile = ctx.config.profileById(String(profileId)) ?? ctx.config.activeProfile()
    ctx.sessions.setModel(id, profile.id, String(model ?? ''))
    logger.info('session.model_changed', { id, profile: profile.id, model })
    return ctx.sessions.view(id)
  })

  ipcMain.handle(IPC.sessionThinking, (_e, rawId: string, thinking: string | null): SessionView => {
    const id = assertSessionId(rawId)
    const value = (['low', 'high', 'max'] as ThinkingEffort[]).includes(thinking as ThinkingEffort)
      ? (thinking as ThinkingEffort)
      : undefined
    ctx.sessions.setThinking(id, value)
    logger.info('session.thinking_changed', { id, thinking: value ?? '(global)' })
    return ctx.sessions.view(id)
  })


  ipcMain.handle(IPC.sessionPin, (_e, rawId: string, pinned: boolean): SessionSummary[] => {
    const id = assertSessionId(rawId)
    ctx.sessions.setPinned(id, Boolean(pinned))
    logger.info('session.pinned', { id, pinned: Boolean(pinned) })
    return ctx.sessions.list()
  })

  /** 在系统文件管理器里定位项目目录；目录还没建好时给出明确提示 */
  ipcMain.handle(IPC.sessionReveal, (_e, id: string): void => {
    const cwd = ctx.sessions.meta(id).cwd
    if (!cwd) throw new Error('这个项目还没有目录，先发一条消息再打开')
    if (!existsSync(cwd)) throw new Error(`目录不存在：${cwd}`)
    shell.showItemInFolder(cwd)
  })

  /**
   * 导出运行轨迹：仿 agent harness 的 trajectory dump。
   * format=json 是机器可读的完整结构；md 是人类可读的分段报告。
   * 弹系统保存框，取消返回 null。
   */
  ipcMain.handle(IPC.sessionTrajectory, async (_e, id: string, format: 'json' | 'md'): Promise<string | null> => {
    const trajectory = buildTrajectory(ctx.sessions, id)
    const safeTitle = (trajectory.title || 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 50)
    const ext = format === 'json' ? 'json' : 'md'
    const win = getWindow()
    const opts = {
      title: '导出运行轨迹',
      defaultPath: `trajectory-${safeTitle}.${ext}`,
      filters: [{ name: format === 'json' ? 'JSON' : 'Markdown', extensions: [ext] }]
    }
    const picked = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (picked.canceled || !picked.filePath) return null

    const content =
      format === 'json' ? JSON.stringify(trajectory, null, 2) : trajectoryToMarkdown(trajectory)
    writeFileSync(picked.filePath, content, 'utf8')
    logger.info('session.trajectory_exported', { id, format, path: picked.filePath })
    return picked.filePath
  })

  ipcMain.handle(IPC.sessionRename, (_e, id: string, title: string): SessionView => {
    ctx.sessions.rename(id, String(title ?? ''))
    return ctx.sessions.view(id)
  })

  ipcMain.handle(IPC.sessionDelete, async (_e, rawId: string) => {
    const id = assertSessionId(rawId)
    // 先停掉正在跑的任务，等它把收尾消息落盘后再删文件，
    // 否则残留的 append 会把已删除的会话文件重新创建出来。
    ctx.runner.abort(id)
    for (let i = 0; i < 50 && ctx.runner.isRunning(id); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    // 等待超时（长 bash / 子任务收尾慢）就不能删：否则 run 继续写会重建已删除的文件
    if (ctx.runner.isRunning(id)) {
      throw new Error('会话正在停止中，请稍后再删除。')
    }
    ctx.sessions.remove(id)
    removeSessionAttachments(id)
    termHost.kill(id)
    if (ctx.config.load().lastSessionId === id) ctx.config.setLastSession(ctx.sessions.list()[0]?.id)
    logger.info('session.deleted', { id })
    return ctx.sessions.list()
  })

  ipcMain.handle(IPC.sessionFork, (_e, id: string, messageId: string): SessionView => {
    if (ctx.runner.isRunning(id)) throw new Error('运行中无法切换分支，请先停止')
    return ctx.sessions.fork(id, messageId)
  })

  ipcMain.handle(IPC.sessionSwitch, (_e, id: string, entryId: string, direction: -1 | 1): SessionView => {
    if (ctx.runner.isRunning(id)) throw new Error('运行中无法切换分支，请先停止')
    return ctx.sessions.switchBranch(id, entryId, direction === -1 ? -1 : 1)
  })

  ipcMain.handle(IPC.chatSend, (_e, id: string, text: string, attachments?: unknown): SendResult => {
    return ctx.runner.send(id, String(text ?? ''), attachments)
  })

  ipcMain.handle(IPC.chatAbort, (_e, id: string) => {
    ctx.runner.abort(id)
    return true
  })

  // ask 工具：渲染层把用户选择回填给等待中的提问（未知的 callId 忽略）
  ipcMain.handle(IPC.askAnswer, (_e, callId: string, choice: number, text: string): boolean =>
    answerAsk(String(callId ?? ''), Number(choice ?? -1), String(text ?? ''))
  )

  /* ---------------- 定时任务 ---------------- */

  ipcMain.handle(IPC.scheduleList, (): ScheduleTask[] => listSchedules())
  ipcMain.handle(
    IPC.scheduleCreate,
    (_e, raw: { name?: unknown; cron?: unknown; prompt?: unknown; sessionId?: unknown }): ScheduleTask =>
      createSchedule({
        name: String(raw?.name ?? ''),
        cron: String(raw?.cron ?? ''),
        prompt: String(raw?.prompt ?? ''),
        sessionId: String(raw?.sessionId ?? '')
      })
  )
  ipcMain.handle(IPC.scheduleUpdate, (_e, id: string, patch: unknown): ScheduleTask => {
    const p = (patch ?? {}) as Record<string, unknown>
    return updateSchedule(String(id ?? ''), {
      name: typeof p.name === 'string' ? p.name : undefined,
      cron: typeof p.cron === 'string' ? p.cron : undefined,
      prompt: typeof p.prompt === 'string' ? p.prompt : undefined,
      sessionId: typeof p.sessionId === 'string' ? p.sessionId : undefined,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined
    })
  })
  ipcMain.handle(IPC.scheduleRemove, (_e, id: string): void => removeSchedule(String(id ?? '')))

  /** 跨会话检索：拿当前会话列表做范围，扫最近 50 个会话的 JSONL */
  ipcMain.handle(IPC.sessionSearch, (_e, query: string): SessionSearchHit[] =>
    searchSessions(String(query ?? ''), ctx.sessions.list())
  )

  /* ---------------- 附件 ---------------- */

  /** 渲染层把文件字节传进来，主进程写到本会话的附件目录并返回元数据 */
  ipcMain.handle(IPC.attachmentStage, (_e, sessionId: string, name: string, mime: string, bytes: unknown) => {
    const sid = assertSessionId(sessionId)
    if (!(bytes instanceof Uint8Array)) throw new Error('无效的附件数据')
    return stageAttachment(sid, String(name ?? ''), String(mime ?? ''), bytes)
  })

  /**
   * 弹系统文件选择框并读出字节（渲染进程沙箱里读不了任意路径）。
   * 只返回字节与元数据，真正的暂存发生在发送时——这样草稿会话也能先挑好附件。
   */
  ipcMain.handle(IPC.attachmentPick, async (_e): Promise<PickedFile[] | null> => {
    const win = getWindow()
    const opts: OpenDialogOptions = {
      title: '添加附件',
      buttonLabel: '添加',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片与文本', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'txt', 'md', 'json', 'csv', 'log', 'ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'css', 'html', 'xml', 'yml', 'yaml', 'toml', 'sh', 'sql'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths.length) return null
    if (result.filePaths.length > MAX_ATTACHMENTS) throw new Error(`一条消息最多带 ${MAX_ATTACHMENTS} 个附件`)
    return Promise.all(
      result.filePaths.map(async (p) => {
        const name = p.split(/[\\/]/).pop() ?? p
        const mime = pickMime(p)
        const info = await stat(p)
        if (!info.isFile()) throw new Error(`「${name}」不是普通文件`)
        if (info.size === 0) throw new Error(`「${name}」是空文件`)
        const limit = attachmentLimit(name, mime)
        if (info.size > limit) {
          const label = limit === MAX_IMAGE_BYTES ? '10MB' : `${MAX_TEXT_BYTES / 1024}KB`
          throw new Error(`附件「${name}」超过 ${label} 上限`)
        }
        const bytes = new Uint8Array(await readFile(p))
        if (bytes.byteLength > limit) throw new Error(`附件「${name}」超过大小上限`)
        return { name, mime, bytes }
      })
    )
  })

  /* ---------------- 工作空间面板 ---------------- */

  /** 面板动作都绑定会话的工作目录；目录缺失时给出人能读懂的错误 */
  const requireCwd = (id: unknown): string => {
    const sid = assertSessionId(id)
    const cwd = ctx.sessions.meta(sid).cwd
    if (!cwd) throw new Error('这个项目还没有目录，先发一条消息再试')
    return cwd
  }

  ipcMain.handle(IPC.workspaceOpen, (_e, id: string): Promise<void> => openWorkspace(requireCwd(id)))

  ipcMain.handle(IPC.workspaceChanges, (_e, id: string) => workspaceChanges(requireCwd(id)))

  ipcMain.handle(IPC.workspaceDiff, (_e, id: string, file: string) => diffOf(requireCwd(id), String(file ?? '')))

  ipcMain.handle(IPC.workspaceFileOpen, (_e, id: string, file: string): Promise<void> =>
    openFile(requireCwd(id), String(file ?? ''))
  )

  /* ---------------- 面板内嵌：文件树 / 终端 ---------------- */

  ipcMain.handle(IPC.fsList, (_e, rawId: string, rel: string) => listDir(requireCwd(rawId), String(rel ?? '')))

  /** @ 引用：搜文件名 / 读文本文件（发送时内联），都限定在会话工作目录内 */
  ipcMain.handle(IPC.fsSearch, (_e, rawId: string, query: string): string[] =>
    searchFiles(requireCwd(rawId), String(query ?? ''))
  )
  ipcMain.handle(IPC.fsRead, (_e, rawId: string, rel: string): { name: string; text: string } | null =>
    readTextFile(requireCwd(rawId), String(rel ?? ''))
  )

  /** 轨迹数据（面板内检查器，不弹保存框） */
  ipcMain.handle(IPC.sessionTrajectoryData, (_e, rawId: string): Trajectory =>
    buildTrajectory(ctx.sessions, assertSessionId(rawId))
  )

  /** 上下文压缩：当前分支 → 摘要新分支（耗时模型调用，渲染层自行展示等待态） */
  ipcMain.handle(IPC.sessionCompact, async (_e, rawId: string): Promise<SessionView> => {
    const id = assertSessionId(rawId)
    await ctx.runner.compact(id)
    return ctx.sessions.view(id)
  })

  // ask 工具：提问事件投递到窗口（渲染层弹卡片）
  bindAskDelivery((payload) => {
    const win = getWindow()
    if (win) win.webContents.send(IPC.event, { type: 'ask_question', ...payload })
  })

  // 内嵌终端事件（流式输出 / 退出）按会话广播给渲染层，渲染层自行按当前会话过滤
  termHost.bind((_sessionId, event) => {
    const win = getWindow()
    if (win) win.webContents.send(IPC.termEvent, event)
  })

  ipcMain.handle(IPC.termSpawn, (_e, rawId: string, kind: unknown): string =>
    termHost.spawn(assertSessionId(rawId), requireCwd(rawId), kind as TermShellKind)
  )

  ipcMain.handle(IPC.termWrite, (_e, rawId: string, line: string): void => {
    termHost.write(assertSessionId(rawId), String(line ?? ''))
  })

  ipcMain.handle(IPC.termData, (_e, rawId: string): string => termHost.data(assertSessionId(rawId)))

  ipcMain.handle(IPC.termKill, (_e, rawId: string): boolean => {
    termHost.kill(assertSessionId(rawId))
    return true
  })

  /* ---------------- 插件 ---------------- */

  ipcMain.handle(IPC.pluginsList, (): PluginInfo[] => pluginHost.list())

  ipcMain.handle(IPC.pluginsReload, (): PluginInfo[] => pluginHost.reload())

  ipcMain.handle(IPC.pluginsInstall, async (_e, mode: 'file' | 'dir'): Promise<PluginInfo[] | null> => {
    const win = getWindow()
    const opts: OpenDialogOptions =
      mode === 'dir'
        ? { title: '选择插件目录', buttonLabel: '安装', properties: ['openDirectory'] }
        : {
            title: '选择插件清单或脚本',
            buttonLabel: '安装',
            properties: ['openFile'],
            filters: [
              { name: '插件', extensions: ['json', 'js', 'cjs'] },
              { name: '所有文件', extensions: ['*'] }
            ]
          }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (result.canceled || !result.filePaths[0]) return null

    pluginHost.install(result.filePaths[0])
    return pluginHost.list()
  })

  /** 从 GitHub 仓库安装；失败把原因带回渲染层直接显示 */
  ipcMain.handle(
    IPC.pluginsInstallGithub,
    async (_e, url: string): Promise<{ ok: boolean; plugins?: PluginInfo[]; error?: string }> => {
      try {
        await pluginHost.installFromGitHub(String(url))
        return { ok: true, plugins: pluginHost.list() }
      } catch (err) {
        const message = (err as Error).message
        logger.warn('plugin.github_install_failed', { url, message })
        return { ok: false, error: message }
      }
    }
  )

  ipcMain.handle(IPC.pluginsToggle, (_e, id: string, enabled: boolean): PluginInfo[] => {
    pluginHost.setEnabled(String(id), Boolean(enabled))
    return pluginHost.list()
  })

  ipcMain.handle(IPC.pluginsRemove, (_e, id: string): PluginInfo[] => {
    pluginHost.remove(String(id))
    return pluginHost.list()
  })

  ipcMain.handle(IPC.pluginsOpenDir, async (): Promise<string> => {
    const dir = paths.plugins()
    const err = await shell.openPath(dir)
    if (err) logger.warn('plugins.open_dir_failed', err)
    return dir
  })

  /**
   * 读取服务商支持的模型名。
   * 优先用界面上尚未保存的 key（用户刚粘贴完就想看列表），否则回落到已存 key / OAuth token。
   */
  ipcMain.handle(IPC.modelsFetch, async (_e, raw: ModelListRequest): Promise<ModelListResult> => {
    const profileId = String(raw?.profileId ?? '')
    const profile = ctx.config.profileById(profileId)
    const protocol: Protocol =
      raw?.protocol === 'anthropic' || raw?.protocol === 'responses' ? raw.protocol : 'openai'
    const baseUrl = String(raw?.baseUrl || profile?.baseUrl || '').trim()
    const typedKey = String(raw?.apiKey ?? '').trim()
    const key = typedKey || (await resolveBearer(ctx.config, profile ?? ctx.config.activeProfile()))

    try {
      const models = await listModels(protocol, baseUrl, key)
      if (profile) ctx.config.saveModels(profileId, models)
      logger.info('models.fetched', { profileId, protocol, baseUrl, count: models.length })
      return { ok: true, models, fetchedAt: Date.now() }
    } catch (err) {
      const error = describeFailure(err)
      logger.warn('models.fetch_failed', { profileId, protocol, baseUrl, kind: error.kind, message: error.message })
      return { ok: false, models: profile?.models ?? [], error }
    }
  })

  /**
   * OpenAI OAuth 登录：起本地回调服务 → 打开浏览器授权 → token 加密存进档案。
   * 全程最多 5 分钟；端口被占用（已有一次登录在进行）直接报错。
   */
  ipcMain.handle(IPC.oauthLogin, async (_e, rawId: string): Promise<{ connected: true; account?: string }> => {
    const profileId = String(rawId ?? '')
    if (!ctx.config.profileById(profileId)) throw new Error(`档案不存在：${profileId}`)
    const login = startLogin({ open: (url) => void shell.openExternal(url) })
    try {
      const tokens = await login.promise
      ctx.config.setOAuth(profileId, tokens)
      logger.info('oauth.connected', { profile: profileId, account: tokens.account })
      return { connected: true, account: tokens.account }
    } catch (err) {
      throw new Error(`OpenAI 登录失败：${(err as Error).message}`)
    }
  })

  ipcMain.handle(IPC.oauthLogout, (_e, rawId: string): void => {
    const profileId = String(rawId ?? '')
    ctx.config.clearOAuth(profileId)
    logger.info('oauth.disconnected', { profile: profileId })
  })
}
