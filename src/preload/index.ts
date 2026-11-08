import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AgentEvent,
  Attachment,
  Bootstrap,
  ChangeList,
  ConfigPatch,
  DirEntry,
  ModelListRequest,
  ModelListResult,
  PickedFile,
  PluginInfo,
  PublicConfig,
  SendResult,
  ScheduleTask,
  SessionSearchHit,
  SessionSummary,
  SessionView,
  TermEvent,
  TermShellKind,
  ThinkingEffort,
  Trajectory
} from '@shared/types'

const api = {
  bootstrap: (): Promise<Bootstrap> => ipcRenderer.invoke(IPC.bootstrap),

  saveConfig: (patch: ConfigPatch): Promise<PublicConfig> => ipcRenderer.invoke(IPC.configSave, patch),
  openLogs: (): Promise<string> => ipcRenderer.invoke(IPC.logsOpen),
  /** 打开（必要时创建模板）SOUL.md 人格文件 */
  editSoul: (): Promise<string> => ipcRenderer.invoke(IPC.soulEdit),

  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke(IPC.sessionList),
  loadSession: (id: string): Promise<SessionView> => ipcRenderer.invoke(IPC.sessionLoad, id),
  newSession: (cwd?: string, preset?: { profileId?: string; model?: string; thinking?: ThinkingEffort }): Promise<SessionView> =>
    ipcRenderer.invoke(IPC.sessionNew, cwd, preset),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickDir),
  setSessionThinking: (id: string, thinking: ThinkingEffort | null): Promise<SessionView> =>
    ipcRenderer.invoke(IPC.sessionThinking, id, thinking),
  setSessionPinned: (id: string, pinned: boolean): Promise<SessionSummary[]> =>
    ipcRenderer.invoke(IPC.sessionPin, id, pinned),
  revealSession: (id: string): Promise<void> => ipcRenderer.invoke(IPC.sessionReveal, id),
  exportTrajectory: (id: string, format: 'json' | 'md'): Promise<string | null> =>
    ipcRenderer.invoke(IPC.sessionTrajectory, id, format),
  changeSessionCwd: (id: string): Promise<SessionView | null> => ipcRenderer.invoke(IPC.sessionCwd, id),
  renameSession: (id: string, title: string): Promise<SessionView> => ipcRenderer.invoke(IPC.sessionRename, id, title),
  deleteSession: (id: string): Promise<SessionSummary[]> => ipcRenderer.invoke(IPC.sessionDelete, id),
  forkSession: (id: string, messageId: string): Promise<SessionView> => ipcRenderer.invoke(IPC.sessionFork, id, messageId),
  switchBranch: (id: string, entryId: string, direction: -1 | 1): Promise<SessionView> =>
    ipcRenderer.invoke(IPC.sessionSwitch, id, entryId, direction),
  setSessionModel: (id: string, profileId: string, model: string): Promise<SessionView> =>
    ipcRenderer.invoke(IPC.sessionModel, id, profileId, model),

  /** 上下文压缩：当前分支总结成摘要 → 切到摘要新分支（耗时模型调用） */
  compactSession: (id: string): Promise<SessionView> => ipcRenderer.invoke(IPC.sessionCompact, id),
  /** 轨迹数据（面板内检查器，不弹保存框） */
  trajectoryData: (id: string): Promise<Trajectory> => ipcRenderer.invoke(IPC.sessionTrajectoryData, id),

  send: (id: string, text: string, attachments?: Attachment[]): Promise<SendResult> =>
    ipcRenderer.invoke(IPC.chatSend, id, text, attachments),
  abort: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.chatAbort, id),
  /** ask 工具：回填用户对结构化提问的选择（choice=-1 表示自行输入） */
  answerAsk: (callId: string, choice: number, text: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.askAnswer, callId, choice, text),

  stageAttachment: (sessionId: string, name: string, mime: string, bytes: Uint8Array): Promise<Attachment> =>
    ipcRenderer.invoke(IPC.attachmentStage, sessionId, name, mime, bytes),
  pickAttachments: (): Promise<PickedFile[] | null> => ipcRenderer.invoke(IPC.attachmentPick),

  openWorkspace: (id: string): Promise<void> => ipcRenderer.invoke(IPC.workspaceOpen, id),
  fetchChanges: (id: string): Promise<ChangeList> => ipcRenderer.invoke(IPC.workspaceChanges, id),
  fetchDiff: (id: string, file: string): Promise<string> => ipcRenderer.invoke(IPC.workspaceDiff, id, file),
  openWorkspaceFile: (id: string, file: string): Promise<void> =>
    ipcRenderer.invoke(IPC.workspaceFileOpen, id, file),

  /** 面板内嵌：目录树单层列表（rel 为空 = 工作目录根） */
  fsList: (id: string, rel: string): Promise<DirEntry[]> => ipcRenderer.invoke(IPC.fsList, id, rel),
  /** 输入区 @ 引用：按名字搜工作目录文件 / 读文本文件（发送时内联） */
  fsSearch: (id: string, query: string): Promise<string[]> => ipcRenderer.invoke(IPC.fsSearch, id, query),
  fsRead: (id: string, rel: string): Promise<{ name: string; text: string } | null> =>
    ipcRenderer.invoke(IPC.fsRead, id, rel),
  /** 面板内嵌终端：spawn（幂等，返回历史缓冲）/ 写一行 / 取历史 / 关闭 */
  termSpawn: (id: string, kind?: TermShellKind): Promise<string> => ipcRenderer.invoke(IPC.termSpawn, id, kind),
  termWrite: (id: string, line: string): Promise<void> => ipcRenderer.invoke(IPC.termWrite, id, line),
  termData: (id: string): Promise<string> => ipcRenderer.invoke(IPC.termData, id),
  termKill: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.termKill, id),
  onTermEvent: (cb: (event: TermEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: TermEvent): void => cb(event)
    ipcRenderer.on(IPC.termEvent, handler)
    return () => ipcRenderer.off(IPC.termEvent, handler)
  },

  fetchModels: (req: ModelListRequest): Promise<ModelListResult> => ipcRenderer.invoke(IPC.modelsFetch, req),

  /** OpenAI OAuth：打开浏览器完成 ChatGPT 登录（回调后 token 存进档案）；logout 清除凭据 */
  oauthLogin: (profileId: string): Promise<{ connected: true; account?: string }> =>
    ipcRenderer.invoke(IPC.oauthLogin, profileId),
  oauthLogout: (profileId: string): Promise<void> => ipcRenderer.invoke(IPC.oauthLogout, profileId),

  /** 内嵌浏览器：guest 的 window.open → 开新浏览器选项卡（按 guestId 认领属于哪个 webview） */
  onBrowserOpenTab: (cb: (payload: { guestId: number; url: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { guestId: number; url: string }): void => cb(payload)
    ipcRenderer.on(IPC.browserOpenTab, handler)
    return () => ipcRenderer.off(IPC.browserOpenTab, handler)
  },

  listPlugins: (): Promise<PluginInfo[]> => ipcRenderer.invoke(IPC.pluginsList),
  reloadPlugins: (): Promise<PluginInfo[]> => ipcRenderer.invoke(IPC.pluginsReload),

  /** 定时任务：列表 / 新建 / 更新（含启停）/ 删除 */
  listSchedules: (): Promise<ScheduleTask[]> => ipcRenderer.invoke(IPC.scheduleList),
  createSchedule: (input: { name: string; cron: string; prompt: string; sessionId: string }): Promise<ScheduleTask> =>
    ipcRenderer.invoke(IPC.scheduleCreate, input),
  updateSchedule: (id: string, patch: { name?: string; cron?: string; prompt?: string; sessionId?: string; enabled?: boolean }): Promise<ScheduleTask> =>
    ipcRenderer.invoke(IPC.scheduleUpdate, id, patch),
  removeSchedule: (id: string): Promise<void> => ipcRenderer.invoke(IPC.scheduleRemove, id),

  /** 跨会话检索：扫最近 50 个会话的消息文本 */
  searchSessions: (query: string): Promise<SessionSearchHit[]> => ipcRenderer.invoke(IPC.sessionSearch, query),
  installPlugin: (mode: 'file' | 'dir'): Promise<PluginInfo[] | null> => ipcRenderer.invoke(IPC.pluginsInstall, mode),
  installPluginFromGitHub: (url: string): Promise<{ ok: boolean; plugins?: PluginInfo[]; error?: string }> =>
    ipcRenderer.invoke(IPC.pluginsInstallGithub, url),
  togglePlugin: (id: string, enabled: boolean): Promise<PluginInfo[]> => ipcRenderer.invoke(IPC.pluginsToggle, id, enabled),
  removePlugin: (id: string): Promise<PluginInfo[]> => ipcRenderer.invoke(IPC.pluginsRemove, id),
  openPluginsDir: (): Promise<string> => ipcRenderer.invoke(IPC.pluginsOpenDir),

  onEvent: (cb: (event: AgentEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: AgentEvent): void => cb(event)
    ipcRenderer.on(IPC.event, handler)
    return () => ipcRenderer.off(IPC.event, handler)
  },

  onMenuAction: (cb: (action: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, action: string): void => cb(action)
    ipcRenderer.on(IPC.menuAction, handler)
    return () => ipcRenderer.off(IPC.menuAction, handler)
  }
}

export type PiApi = typeof api

contextBridge.exposeInMainWorld('pi', api)
