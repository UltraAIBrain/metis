import type {
  AgentEvent,
  Attachment,
  AssistantMessage,
  Bootstrap,
  ChangeList,
  ConfigPatch,
  DirEntry,
  Message,
  ModelListResult,
  ModelOption,
  PickedFile,
  PluginInfo,
  PublicConfig,
  PublicProfile,
  SessionSummary,
  SessionView,
  TermShellKind,
  ThinkingEffort,
  ToolMessage,
  Trajectory
} from '@shared/types'
import { lookupModel, resolveContextWindow } from '@shared/model-catalog'
import { useCallback, useRef, useSyncExternalStore } from 'react'

export interface SendOutcome {
  ok: boolean
  sessionId: string
}

export interface LiveState {
  messageId: string
  text: string
  /** 思维链尾部，只用于"思考中"的提示 */
  thinking: string
  tools: { callId: string; name: string; label?: string }[]
  /** 子智能体正在执行的工具（不落盘，只做进度反馈） */
  subTools: { callId: string; taskCallId: string; label: string; name: string }[]
}

export interface Notice {
  id: string
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface PendingQuestion {
  sessionId: string
  callId: string
  question: string
  options: string[]
}

export interface State {
  ready: boolean
  fatal: string | null
  app: Bootstrap | null
  config: PublicConfig
  sessions: SessionSummary[]
  session: SessionView | null
  /** 按会话隔离的流式状态，切换会话不会丢正在生成的内容 */
  live: Record<string, LiveState>
  runningIds: string[]
  queue: Record<string, string[]>
  notices: Notice[]
  settingsOpen: boolean
  loading: boolean
  /** 本次运行中临时拉到的模型列表，优先于配置里的缓存 */
  modelCache: Record<string, ModelOption[]>
  plugins: PluginInfo[]
  /** 会话区右侧的功能面板是否展开 */
  panelOpen: boolean
  /** 功能面板完整视图：面板接管聊天区，顶部多选项卡切换 */
  panelFull: boolean
  /** 按到达顺序保留各会话的待回答提问，界面一次展示一条。 */
  askQueue: PendingQuestion[]
}

/** 草稿会话 id：新建后未发消息时存在，不写磁盘、不进侧栏 */
/** IPC 抛回来的错误会带一长串前缀，剥掉只留人能读的部分 */
export function cleanIpcError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

export const DRAFT_ID = 'draft'

export function isDraftSession(state: State): boolean {
  return state.session?.id === DRAFT_ID
}

function draftSession(cwd = ''): SessionView {
  return {
    id: DRAFT_ID,
    title: '',
    cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    leafId: null,
    messages: [],
    branch: {}
  }
}

const EMPTY_CONFIG: PublicConfig = {
  lastCwd: '',
  activeProfileId: 'openai',
  profiles: [],
  model: '',
  temperature: 0.2,
  maxTokens: 0,
  shell: 'auto',
  thinking: 'high'
}

let noticeSeq = 0

class Store {
  private state: State = {
    ready: false,
    fatal: null,
    app: null,
    config: EMPTY_CONFIG,
    sessions: [],
    session: null,
    live: {},
    runningIds: [],
    queue: {},
    notices: [],
    settingsOpen: false,
    loading: false,
    modelCache: {},
    plugins: [],
    panelOpen: localStorage.getItem('pi.panelOpen') !== '0',
    panelFull: false,
    askQueue: []
  }

  private listeners = new Set<() => void>()
  private initialized = false
  private navigationSeq = 0
  private sessionsSeq = 0
  private sendingIds = new Set<string>()
  private modelSeq = new Map<string, number>()
  private liveFrame: number | null = null
  private pendingLive = new Map<string, { messageId: string; text: string; thinking: string }>()

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): State => this.state

  private set(patch: Partial<State> | ((s: State) => Partial<State>)): void {
    const next = typeof patch === 'function' ? patch(this.state) : patch
    this.state = { ...this.state, ...next }
    for (const fn of this.listeners) fn()
  }

  /** 草稿会话的占位 id：只在内存里存在，发第一条消息时才真正落盘 */
  private get currentId(): string | null {
    const id = this.state.session?.id
    return !id || id === DRAFT_ID ? null : id
  }

  /* ---------------- 初始化 ---------------- */

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    if (typeof window === 'undefined' || !window.pi) {
      this.set({ ready: true, fatal: '预加载脚本未注入，应用无法与主进程通信。请重新启动。' })
      return
    }

    window.pi.onEvent((event) => this.onEvent(event))
    window.pi.onMenuAction((action) => this.onMenuAction(action))

    try {
      const app = await window.pi.bootstrap()
      const session = await this.resolveInitialSession(app)
      this.set({ ready: true, app, config: app.config, sessions: app.sessions, session, runningIds: app.running })
      void this.loadPlugins()
    } catch (err) {
      this.set({ ready: true, fatal: `初始化失败：${(err as Error).message}` })
    }
  }

  private async resolveInitialSession(app: Bootstrap): Promise<SessionView | null> {
    const list = app.sessions
    const preferred =
      app.config.lastSessionId && list.some((s) => s.id === app.config.lastSessionId)
        ? app.config.lastSessionId
        : list[0]?.id
    if (!preferred) return null // 没有项目就显示起始页，不偷偷弹目录选择框
    try {
      return await window.pi.loadSession(preferred)
    } catch {
      return null
    }
  }

  /* ---------------- 会话操作 ---------------- */

  /**
   * 新建项目只开一个内存里的草稿，不写磁盘：
   * 只有真正发出第一条消息（或附件）时才会创建会话文件。
   */
  async newSession(mode: 'auto' | 'pick' = 'auto'): Promise<void> {
    const request = ++this.navigationSeq
    if (mode === 'pick') {
      try {
        const dir = await window.pi.pickDirectory()
        if (!dir || request !== this.navigationSeq) return
        this.set({ session: draftSession(dir), loading: false })
      } catch (err) {
        this.notify('error', `选择目录失败：${(err as Error).message}`)
      }
      return
    }
    this.set({ session: draftSession(), loading: false })
  }

  /** 更换当前项目的目录；会话开始后不再允许改 */
  async changeCwd(): Promise<void> {
    const session = this.state.session
    if (!session) return
    const navigation = this.navigationSeq
    if (session.id === DRAFT_ID) {
      try {
        const dir = await window.pi.pickDirectory()
        if (dir && navigation === this.navigationSeq && this.state.session === session) {
          this.set({ session: { ...session, cwd: dir } })
        }
      } catch (err) {
        this.notify('error', `选择目录失败：${(err as Error).message}`)
      }
      return
    }
    const id = this.currentId
    if (!id) return
    if ((this.state.session?.messages.length ?? 0) > 0) {
      this.notify('warn', '会话已经开始，目录不可更改。需要换目录请新建项目。')
      return
    }
    try {
      const view = await window.pi.changeSessionCwd(id)
      if (!view || navigation !== this.navigationSeq || this.currentId !== id) return
      this.set({ session: view })
      const sessions = await this.listSessions()
      if (sessions && navigation === this.navigationSeq && this.currentId === id) this.set({ sessions })
    } catch (err) {
      this.notify('error', `更换目录失败：${(err as Error).message}`)
    }
  }

  async selectSession(id: string): Promise<void> {
    if (id === this.currentId) return
    const request = ++this.navigationSeq
    this.set({ loading: true })
    try {
      const view = await window.pi.loadSession(id)
      if (request !== this.navigationSeq) return
      this.set({ session: view, loading: false })
    } catch (err) {
      if (request === this.navigationSeq) this.set({ loading: false })
      this.notify('error', `打开会话失败：${(err as Error).message}`)
    }
  }

  async deleteSession(id: string): Promise<void> {
    const deletingCurrent = id === this.currentId
    const navigation = deletingCurrent ? ++this.navigationSeq : this.navigationSeq
    try {
      const sessions = await window.pi.deleteSession(id)
      // 清掉该会话的流式/排队残留，避免幽灵状态
      const live = { ...this.state.live }
      delete live[id]
      const queue = { ...this.state.queue }
      delete queue[id]
      if (deletingCurrent) {
        // 删掉的是当前项目：还有别的就切过去，没有就回到起始页（不自动建）
        const next = sessions[0] ? await window.pi.loadSession(sessions[0].id) : null
        if (navigation !== this.navigationSeq) return
        this.set({ session: next, sessions, loading: false, live, queue })
      } else {
        this.set({ sessions, live, queue })
      }
    } catch (err) {
      this.notify('error', `删除会话失败：${(err as Error).message}`)
    }
  }

  /** 置顶 / 取消置顶：主进程返回重排后的完整列表 */
  async setSessionPinned(id: string, pinned: boolean): Promise<void> {
    try {
      this.set({ sessions: await window.pi.setSessionPinned(id, pinned) })
    } catch (err) {
      this.notify('error', `置顶失败：${cleanIpcError(err)}`)
    }
  }

  /** 在系统文件管理器里定位项目目录 */
  async revealSession(id: string): Promise<void> {
    try {
      await window.pi.revealSession(id)
    } catch (err) {
      this.notify('error', cleanIpcError(err))
    }
  }

  /** 导出运行轨迹（JSON 机器可读 / Markdown 人类可读）；取消保存框静默返回 */
  async exportTrajectory(id: string, format: 'json' | 'md'): Promise<void> {
    try {
      const savedTo = await window.pi.exportTrajectory(id, format)
      if (savedTo) this.notify('info', `轨迹已导出到 ${savedTo}`)
    } catch (err) {
      this.notify('error', `导出轨迹失败：${cleanIpcError(err)}`)
    }
  }

  async renameSession(id: string, title: string): Promise<void> {
    const navigation = this.navigationSeq
    try {
      const view = await window.pi.renameSession(id, title)
      const sessions = await this.listSessions()
      if (!sessions || navigation !== this.navigationSeq) return
      this.set({ sessions, session: id === this.currentId ? view : this.state.session })
    } catch (err) {
      this.notify('error', `重命名失败：${(err as Error).message}`)
    }
  }

  async fork(messageId: string): Promise<void> {
    const id = this.currentId
    if (!id) return
    const navigation = this.navigationSeq
    try {
      const view = await window.pi.forkSession(id, messageId)
      if (navigation !== this.navigationSeq || this.currentId !== id) return
      this.set({ session: view })
      this.notify('info', '已切换到该消息处分叉，下一条消息会创建新分支。')
    } catch (err) {
      this.notify('error', `分叉失败：${(err as Error).message}`)
    }
  }

  async switchBranch(entryId: string, direction: -1 | 1): Promise<void> {
    const id = this.currentId
    if (!id) return
    const navigation = this.navigationSeq
    try {
      const view = await window.pi.switchBranch(id, entryId, direction)
      if (navigation !== this.navigationSeq || this.currentId !== id) return
      this.set({ session: view })
    } catch (err) {
      this.notify('error', `切换分支失败：${(err as Error).message}`)
    }
  }

  /** 绑定当前会话使用的提供商与模型，只影响这个会话之后的请求 */
  async setSessionModel(profileId: string, model: string): Promise<boolean> {
    const session = this.state.session
    if (session?.id === DRAFT_ID) {
      // 草稿阶段先记在内存里，创建会话时一并写进 meta
      this.set({ session: { ...session, profileId, model } })
      return true
    }
    const id = this.currentId
    if (!id) return false
    const navigation = this.navigationSeq
    try {
      const view = await window.pi.setSessionModel(id, profileId, model)
      if (navigation !== this.navigationSeq || this.currentId !== id) return false
      this.set({ session: view })
      return true
    } catch (err) {
      this.notify('error', `切换模型失败：${(err as Error).message}`)
      return false
    }
  }

  /** 切换当前会话的思考强度；只影响这个会话之后的请求 */
  async setSessionThinking(thinking: ThinkingEffort | undefined): Promise<void> {
    const session = this.state.session
    if (!session) return
    if (session.id === DRAFT_ID) {
      this.set({ session: { ...session, thinking } })
      return
    }
    const navigation = this.navigationSeq
    try {
      const view = await window.pi.setSessionThinking(session.id, thinking ?? null)
      if (navigation !== this.navigationSeq || this.currentId !== session.id) return
      this.set({ session: view })
    } catch (err) {
      this.notify('error', `切换思考强度失败：${(err as Error).message}`)
    }
  }


  /** 拉取某家提供商的模型列表，结果同时写进内存缓存 */
  async loadModels(profile: PublicProfile): Promise<ModelListResult> {
    const request = (this.modelSeq.get(profile.id) ?? 0) + 1
    this.modelSeq.set(profile.id, request)
    const res = await window.pi.fetchModels({
      profileId: profile.id,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl
    })
    if (res.ok && this.modelSeq.get(profile.id) === request) {
      this.set({ modelCache: { ...this.state.modelCache, [profile.id]: res.models } })
    }
    return res
  }

  /* ---------------- 对话 ---------------- */

  /**
   * 发送消息；files 是渲染层持有的附件字节（选择框 / 粘贴 / 拖拽），
   * 真正的暂存放在这里：草稿会话先落盘拿到真实 id，附件才进对的目录。
   */
  async send(sessionId: string, text: string, files?: PickedFile[]): Promise<SendOutcome | null> {
    const trimmed = text.trim()
    if (!trimmed && !files?.length) return null

    let session = this.state.session
    // @ 文件读取发生在提交之前；切换会话后不得把旧输入发给当前会话。
    if (session?.id !== sessionId) {
      this.notify('warn', '会话已切换，消息保留在原会话草稿中，请切回后重试。')
      return { ok: false, sessionId }
    }
    if (!session || this.sendingIds.has(session.id)) return null

    const locks = new Set<string>([session.id])
    const navigation = this.navigationSeq
    locks.forEach((id) => this.sendingIds.add(id))
    let createdFromDraft = false
    try {
      // 草稿：先把会话落盘，再发消息；这样事件里的 sessionId 才是真的
      if (session.id === DRAFT_ID) {
        const view = await window.pi.newSession(session.cwd, {
          profileId: session.profileId,
          model: session.model,
          thinking: session.thinking
        })
        session = view
        createdFromDraft = true
        this.sendingIds.add(view.id)
        locks.add(view.id)
        if (this.navigationSeq === navigation && this.state.session?.id === DRAFT_ID) this.set({ session: view })
      }

      let attachments: Attachment[] | undefined
      if (files?.length) {
        // 任一附件暂存失败就整条不发，让用户把它移出去后再发
        attachments = []
        for (const f of files) {
          attachments.push(await window.pi.stageAttachment(session.id, f.name, f.mime, f.bytes))
        }
      }
      await window.pi.send(session.id, trimmed, attachments)
      return { ok: true, sessionId: session.id }
    } catch (err) {
      this.notify('error', `${session.id === DRAFT_ID ? '创建会话' : '发送'}失败：${(err as Error).message}`)
      return { ok: false, sessionId: session.id }
    } finally {
      locks.forEach((id) => this.sendingIds.delete(id))
      // 标题由首条消息生成，落盘后再刷新列表，侧栏才不会停在"新会话"
      if (createdFromDraft) {
        try {
          const sessions = await this.listSessions()
          if (sessions) this.set({ sessions })
        } catch {
          /* 列表刷新失败不影响当前会话 */
        }
      }
    }
  }

  async abort(): Promise<void> {
    const id = this.currentId
    if (!id) return
    try {
      await window.pi.abort(id)
    } catch (err) {
      this.notify('error', `停止失败：${(err as Error).message}`)
    }
  }

  /* ---------------- 配置 ---------------- */

  async saveConfig(patch: ConfigPatch): Promise<boolean> {
    try {
      const config = await window.pi.saveConfig(patch)
      const sessions = await this.listSessions()
      if (!sessions) return false
      this.set({ config, sessions, settingsOpen: false })
      return true
    } catch (err) {
      this.notify('error', `保存配置失败：${(err as Error).message}`)
      return false
    }
  }

  /* ---------------- 插件 ---------------- */

  async loadPlugins(): Promise<void> {
    try {
      this.set({ plugins: await window.pi.listPlugins() })
    } catch (err) {
      this.notify('error', `读取插件失败：${(err as Error).message}`)
    }
  }

  async installPlugin(mode: 'file' | 'dir'): Promise<void> {
    try {
      const list = await window.pi.installPlugin(mode)
      if (!list) return // 用户取消
      this.set({ plugins: list })
      this.notify('info', '插件已安装')
    } catch (err) {
      this.notify('error', `安装插件失败：${(err as Error).message}`)
    }
  }

  /** 从 GitHub 在线安装；返回错误信息（成功返回 null）方便界面就地展示 */
  async installPluginFromGitHub(url: string): Promise<string | null> {
    try {
      const res = await window.pi.installPluginFromGitHub(url)
      if (!res.ok) {
        const msg = res.error ?? '安装失败'
        this.notify('error', msg)
        return msg
      }
      this.set({ plugins: res.plugins ?? [] })
      this.notify('info', '插件已从 GitHub 安装')
      return null
    } catch (err) {
      const msg = (err as Error).message
      this.notify('error', `安装失败：${msg}`)
      return msg
    }
  }

  async togglePlugin(id: string, enabled: boolean): Promise<void> {
    try {
      this.set({ plugins: await window.pi.togglePlugin(id, enabled) })
    } catch (err) {
      this.notify('error', `切换插件状态失败：${(err as Error).message}`)
    }
  }

  async removePlugin(id: string): Promise<void> {
    try {
      this.set({ plugins: await window.pi.removePlugin(id) })
      this.notify('info', '插件已卸载')
    } catch (err) {
      this.notify('error', `卸载插件失败：${(err as Error).message}`)
    }
  }

  async reloadPlugins(): Promise<void> {
    try {
      this.set({ plugins: await window.pi.reloadPlugins() })
      this.notify('info', '已重新加载插件')
    } catch (err) {
      this.notify('error', `重新加载失败：${(err as Error).message}`)
    }
  }

  async openPluginsDir(): Promise<void> {
    try {
      const dir = await window.pi.openPluginsDir()
      this.notify('info', `插件目录：${dir}`)
    } catch (err) {
      this.notify('error', `打开插件目录失败：${(err as Error).message}`)
    }
  }

  async openLogs(): Promise<void> {
    try {
      const dir = await window.pi.openLogs()
      this.notify('info', `已打开日志目录：${dir}`)
    } catch (err) {
      this.notify('error', `打开日志失败：${(err as Error).message}`)
    }
  }

  /** 打开（必要时创建模板）SOUL.md 人格文件 */
  async editSoul(): Promise<void> {
    try {
      const file = await window.pi.editSoul()
      this.notify('info', `已打开人格文件：${file}`)
    } catch (err) {
      this.notify('error', `打开人格文件失败：${(err as Error).message}`)
    }
  }

  openSettings(): void {
    this.set({ settingsOpen: true })
  }

  closeSettings(): void {
    this.set({ settingsOpen: false })
  }

  togglePanel(): void {
    const panelOpen = !this.state.panelOpen
    localStorage.setItem('pi.panelOpen', panelOpen ? '1' : '0')
    /* 面板收起时同步退出完整视图，避免下次打开直接接管聊天区 */
    this.set(panelOpen ? { panelOpen } : { panelOpen, panelFull: false })
  }

  /** 回答 ask 工具的结构化提问（choice=-1 表示自行输入） */
  async answerAsk(sessionId: string, callId: string, choice: number, text: string): Promise<void> {
    try {
      await window.pi.answerAsk(callId, choice, text)
      // false 表示该提问已经结束；同样移除它，但不影响刚到达的其他提问。
      this.closeAsk(sessionId, callId)
    } catch (err) {
      this.notify('error', cleanIpcError(err))
    }
  }

  private closeAsk(sessionId: string, callId: string): void {
    this.set({ askQueue: this.state.askQueue.filter((ask) => ask.sessionId !== sessionId || ask.callId !== callId) })
  }

  togglePanelFull(): void {
    this.set({ panelFull: !this.state.panelFull })
  }

  /* ---------------- 工作空间面板 ---------------- */

  /** 在系统文件管理器中打开工作目录（文件树视图里的辅助入口） */
  async openWorkspace(id: string): Promise<void> {
    if (id === DRAFT_ID) return
    try {
      await window.pi.openWorkspace(id)
    } catch (err) {
      this.notify('error', cleanIpcError(err))
    }
  }

  /** 目录树单层列表（懒加载） */
  async fetchDir(id: string, rel: string): Promise<DirEntry[]> {
    if (id === DRAFT_ID) return []
    return window.pi.fsList(id, rel)
  }

  /** @ 引用：搜工作目录文件名（草稿会话没有目录，返回空） */
  async searchFiles(id: string, query: string): Promise<string[]> {
    if (id === DRAFT_ID) return []
    try {
      return await window.pi.fsSearch(id, query)
    } catch {
      return []
    }
  }

  /** @ 引用：读工作目录内文本文件（返回 null = 不存在/二进制/超限，调用方跳过） */
  async readFile(id: string, rel: string): Promise<{ name: string; text: string } | null> {
    if (id === DRAFT_ID) return null
    try {
      return await window.pi.fsRead(id, rel)
    } catch {
      return null
    }
  }

  /** 上下文压缩：成功返回新视图；失败抛错由调用方提示 */
  async compactSession(id: string): Promise<void> {
    if (id === DRAFT_ID) throw new Error('草稿会话不能压缩')
    await window.pi.compactSession(id)
  }

  /** 轨迹数据（面板内检查器） */
  async trajectoryData(id: string): Promise<Trajectory> {
    if (id === DRAFT_ID) throw new Error('草稿会话还没有轨迹')
    return window.pi.trajectoryData(id)
  }

  /** 内嵌终端：spawn（幂等，返回历史缓冲）；kind 指定 shell，默认平台自动 */
  async spawnTerm(id: string, kind?: TermShellKind): Promise<string> {
    if (id === DRAFT_ID) return ''
    return window.pi.termSpawn(id, kind)
  }

  writeTerm(id: string, line: string): Promise<void> {
    return window.pi.termWrite(id, line)
  }

  fetchTermData(id: string): Promise<string> {
    return window.pi.termData(id)
  }

  async killTerm(id: string): Promise<void> {
    try {
      await window.pi.termKill(id)
    } catch (err) {
      this.notify('error', `关闭终端失败：${cleanIpcError(err)}`)
    }
  }

  async fetchChanges(id: string): Promise<ChangeList> {
    if (id === DRAFT_ID) return { supported: false, files: [] }
    return window.pi.fetchChanges(id)
  }

  fetchDiff(id: string, file: string): Promise<string> {
    if (id === DRAFT_ID) return Promise.resolve('')
    return window.pi.fetchDiff(id, file)
  }

  async openWorkspaceFile(id: string, file: string): Promise<void> {
    if (id === DRAFT_ID) return
    try {
      await window.pi.openWorkspaceFile(id, file)
    } catch (err) {
      this.notify('error', cleanIpcError(err))
    }
  }

  /* ---------------- 事件 ---------------- */

  private appendMessage(sessionId: string, message: Message): void {
    const s = this.state
    if (s.session?.id !== sessionId) return
    this.set({ session: { ...s.session, messages: [...s.session.messages, message] } })
  }

  private queueLiveDelta(sessionId: string, messageId: string, text: string, thinking: string): void {
    const previous = this.pendingLive.get(sessionId)
    const pending = previous?.messageId === messageId ? previous : { messageId, text: '', thinking: '' }
    pending.text += text
    pending.thinking += thinking
    this.pendingLive.set(sessionId, pending)
    if (this.liveFrame !== null) return
    this.liveFrame = requestAnimationFrame(() => this.flushLive())
  }

  private flushLive(): void {
    if (this.liveFrame !== null) cancelAnimationFrame(this.liveFrame)
    this.liveFrame = null
    if (!this.pendingLive.size) return
    let live = this.state.live
    for (const [sessionId, pending] of this.pendingLive) {
      const current = live[sessionId]
      if (!current || current.messageId !== pending.messageId) continue
      live = {
        ...live,
        [sessionId]: {
          ...current,
          text: current.text + pending.text,
          thinking: (current.thinking + pending.thinking).slice(-200)
        }
      }
    }
    this.pendingLive.clear()
    this.set({ live })
  }

  private onEvent(e: AgentEvent): void {
    if (['assistant_start', 'tool_start', 'tool_end', 'assistant_end', 'run_end'].includes(e.type)) this.flushLive()
    const s = this.state

    switch (e.type) {
      case 'message_added': {
        this.appendMessage(e.sessionId, e.message)
        // 队列里的消息被注入成正式消息后，排队标签要同步出队
        if (e.message.role === 'user') {
          const q = s.queue[e.sessionId]
          if (q?.length) this.set({ queue: { ...s.queue, [e.sessionId]: q.slice(1) } })
        }
        this.refreshSessions()
        break
      }
      case 'run_start': {
        if (!s.runningIds.includes(e.sessionId)) this.set({ runningIds: [...s.runningIds, e.sessionId] })
        break
      }
      case 'assistant_start': {
        this.set({
          live: {
            ...s.live,
            [e.sessionId]: { messageId: e.messageId, text: '', thinking: '', tools: [], subTools: [] }
          }
        })
        break
      }
      case 'thinking_delta': {
        const live = s.live[e.sessionId]
        if (!live || live.messageId !== e.messageId) break
        this.queueLiveDelta(e.sessionId, e.messageId, '', e.delta)
        break
      }
      case 'text_delta': {
        const live = s.live[e.sessionId]
        if (!live || live.messageId !== e.messageId) break
        this.queueLiveDelta(e.sessionId, e.messageId, e.delta, '')
        break
      }
      case 'tool_start': {
        const live = s.live[e.sessionId]
        if (!live) break
        // task 带上子任务标签，运行中提示才可读（"task · 搜索测试失败"而不是裸的 "task"）
        const label = e.name === 'task' && typeof e.input?.label === 'string' ? e.input.label : undefined
        this.set({
          live: {
            ...s.live,
            [e.sessionId]: { ...live, tools: [...live.tools, { callId: e.callId, name: e.name, label }] }
          }
        })
        break
      }
      case 'tool_end': {
        const live = s.live[e.sessionId]
        this.appendMessage(e.sessionId, e.message)
        if (live) {
          this.set({
            live: { ...s.live, [e.sessionId]: { ...live, tools: live.tools.filter((t) => t.callId !== e.message.toolCallId) } }
          })
        }
        break
      }
      case 'assistant_end': {
        const nextLive = { ...s.live }
        delete nextLive[e.sessionId]
        this.appendMessage(e.sessionId, e.message)
        this.set({ live: nextLive })
        break
      }
      case 'steering_queued': {
        const q = s.queue[e.sessionId] ?? []
        this.set({ queue: { ...s.queue, [e.sessionId]: [...q, e.text] } })
        break
      }
      /**
       * 子智能体的工具活动（不落盘）：运行中的 task 卡片下面实时显示它正在做什么，
       * 否则长任务只有一个 spinner，观感等同于卡死。
       */
      case 'subagent_tool': {
        const live = s.live[e.sessionId]
        if (!live) break
        const others = live.subTools.filter((t) => t.callId !== e.callId)
        const subTools =
          e.phase === 'start'
            ? [...others, { callId: e.callId, taskCallId: e.taskCallId, label: e.label, name: e.name }]
            : others
        this.set({ live: { ...s.live, [e.sessionId]: { ...live, subTools } } })
        break
      }
      case 'session_cwd': {
        if (s.session?.id === e.sessionId) this.set({ session: { ...s.session, cwd: e.cwd } })
        break
      }
      case 'notice': {
        this.notify(e.level, e.text)
        break
      }
      case 'ask_question': {
        if (!s.askQueue.some((ask) => ask.sessionId === e.sessionId && ask.callId === e.callId)) {
          this.set({ askQueue: [...s.askQueue, { sessionId: e.sessionId, callId: e.callId, question: e.question, options: e.options }] })
        }
        break
      }
      case 'ask_closed': {
        this.closeAsk(e.sessionId, e.callId)
        break
      }
      case 'run_end': {
        const nextLive = { ...s.live }
        delete nextLive[e.sessionId]
        this.set({
          live: nextLive,
          runningIds: s.runningIds.filter((id) => id !== e.sessionId),
          queue: { ...s.queue, [e.sessionId]: [] },
          askQueue: s.askQueue.filter((ask) => ask.sessionId !== e.sessionId)
        })
        if (e.sessionId === s.session?.id) void this.reloadSession(e.sessionId)
        this.refreshSessions()
        break
      }
      case 'session_compacted': {
        // 压缩完成：当前分支已切到摘要根，直接替换视图（本地没有可依赖的增量事件）
        if (e.sessionId === s.session?.id) void this.reloadSession(e.sessionId, true)
        this.refreshSessions()
        break
      }
    }
  }

  private async reloadSession(id: string, force = false): Promise<void> {
    const before = this.state.session?.id === id ? this.state.session.messages.length : -1
    try {
      const view = await window.pi.loadSession(id)
      const cur = this.state.session
      if (cur?.id !== id) return
      // run_end 后用户可能立刻发了下一条消息：本地已通过事件补齐，不要用旧快照覆盖
      //（压缩等结构性变化用 force 强制替换）
      if (!force && before >= 0 && cur.messages.length !== before) return
      this.set({ session: view })
    } catch {
      /* 会话可能已被删除 */
    }
  }

  private async listSessions(): Promise<SessionSummary[] | null> {
    const request = ++this.sessionsSeq
    const sessions = await window.pi.listSessions()
    return request === this.sessionsSeq ? sessions : null
  }

  /** 列表刷新做 300ms 合并：一次运行会产生大量 message_added，不必每条都拉全量列表 */
  private refreshTimer: ReturnType<typeof setTimeout> | null = null

  private refreshSessions(): void {
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.listSessions()
        .then((sessions) => {
          if (sessions) this.set({ sessions })
        })
        .catch(() => {
          /* 忽略 */
        })
    }, 300)
  }

  private onMenuAction(action: string): void {
    switch (action) {
      case 'new-session':
        void this.newSession('auto')
        break
      case 'new-session-pick':
        void this.newSession('pick')
        break
      case 'change-cwd':
        void this.changeCwd()
        break
      case 'settings':
        this.openSettings()
        break
      case 'open-logs':
        void this.openLogs()
        break
      case 'about':
        this.notify(
          'info',
          `Metis ${this.state.app?.appVersion ?? ''} · 数据目录 ${this.state.app?.dataDir ?? ''}`
        )
        break
    }
  }

  notify(level: Notice['level'], text: string): void {
    const id = `n${++noticeSeq}`
    this.set({ notices: [...this.state.notices, { id, level, text }] })
    const ttl = level === 'error' ? 9000 : 4500
    setTimeout(() => this.dismiss(id), ttl)
  }

  dismiss(id: string): void {
    this.set({ notices: this.state.notices.filter((n) => n.id !== id) })
  }
}

export const store = new Store()

export function useApp(): State {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/**
 * 按切片订阅：selector 结果不变（Object.is）就不触发本组件重渲染。
 * 流式输出时每个 delta 都会更新整份 state，只关心 sessions / runningIds
 * 这类切片的组件（侧栏、状态栏、顶栏 chip）用这个 hook 避免跟着每条 delta 重渲染。
 */
export function useSlice<T>(selector: (s: State) => T): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const cache = useRef<{ state: State; value: T } | null>(null)
  const getSnapshot = useCallback((): T => {
    const state = store.getSnapshot()
    const last = cache.current
    if (last && last.state === state) return last.value
    const value = selectorRef.current(state)
    if (last && Object.is(last.value, value)) {
      cache.current = { state, value: last.value }
      return last.value
    }
    cache.current = { state, value }
    return value
  }, [])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/** 当前生效的提供商档案（全局默认） */
export function activeProfileOf(state: Pick<State, 'config'>): PublicProfile | undefined {
  const { profiles, activeProfileId } = state.config
  return profiles.find((p) => p.id === activeProfileId) ?? profiles[0]
}

/** 当前会话实际使用的提供商：会话绑定优先，否则回落全局默认 */
export function sessionProfileOf(state: Pick<State, 'config' | 'session'>): PublicProfile | undefined {
  const bound = state.session?.profileId
  if (bound) {
    const hit = state.config.profiles.find((p) => p.id === bound)
    if (hit) return hit
  }
  return activeProfileOf(state)
}

/** 当前会话实际使用的模型名 */
export function sessionThinkingOf(state: Pick<State, 'session' | 'config'>): ThinkingEffort {
  return state.session?.thinking ?? state.config.thinking ?? 'high'
}

export function sessionModelOf(state: Pick<State, 'session' | 'config'>): string {
  return state.session?.model?.trim() || state.config.model
}

/** 某家提供商可选的模型：优先本次运行新拉的，其次配置缓存 */
export function modelsOf(state: Pick<State, 'modelCache'>, profile?: PublicProfile): ModelOption[] {
  if (!profile) return []
  return state.modelCache[profile.id] ?? profile.models
}

/**
 * 当前会话模型的上下文窗口（tokens）：接口返回的优先，其次内置兜底表。
 * 与 runner 取 maxOutput、modelSupportsImagesOf 取 inputs 的顺序保持一致——
 * 只查内置表会让「接口说 1M、表里写 128K」的模型被算成严重超限（假 100%）。
 */
export function contextWindowOf(state: Pick<State, 'config' | 'session' | 'modelCache'>): number | undefined {
  const model = sessionModelOf(state)
  if (!model) return undefined
  const cached = modelsOf(state, sessionProfileOf(state)).find((m) => m.id === model)
  return resolveContextWindow(model, cached)
}

export function isRunning(state: Pick<State, 'runningIds' | 'session'>): boolean {
  const id = state.session?.id
  return Boolean(id && state.runningIds.includes(id))
}

/**
 * 当前模型是否支持图片输入。模型参数未知（没拉过接口、内置表也没有）时
 * 宁可放行——图片发出去服务端报错也看得见；只有明确不支持时才拦。
 */
export function modelSupportsImagesOf(state: Pick<State, 'config' | 'session' | 'modelCache'>): boolean {
  const profile = sessionProfileOf(state)
  const model = sessionModelOf(state)
  const cached = profile ? (state.modelCache[profile.id] ?? profile.models).find((m) => m.id === model) : undefined
  const inputs = cached?.inputs ?? lookupModel(model)?.inputs
  return !inputs || inputs.includes('image')
}

/** 产物列表里的一项 */
export interface Artifact {
  path: string
  kind: 'write' | 'edit'
  ts: number
}

/**
 * 本会话产出过的文件：从 write / edit 工具记录推导，
 * 同一文件取最近一次操作，最新的排前面。
 */
export function artifactsOf(session: Pick<SessionView, 'messages'>): Artifact[] {
  const byPath = new Map<string, Artifact>()
  for (const m of session.messages) {
    if (m.role !== 'tool' || m.isError) continue
    const meta = (m as ToolMessage).meta
    if (!meta || (meta.kind !== 'write' && meta.kind !== 'edit')) continue
    byPath.set(meta.path, { path: meta.path, kind: meta.kind, ts: (m as ToolMessage).ts })
  }
  return [...byPath.values()].sort((a, b) => b.ts - a.ts)
}

export type { AssistantMessage, ToolMessage, SessionSummary }
