/**
 * 主进程 / 渲染进程共享的领域类型。
 * 这里只描述"代理"本身的概念，不夹带任何 UI 或 Electron 细节。
 */

/** 协议族：openai / anthropic 为 chat/completions 与 messages 两套 SSE；
 *  responses 是 OpenAI Responses API（ChatGPT 登录后的 codex 后端走这一套） */
export type Protocol = 'openai' | 'anthropic' | 'responses'

/** 历史命名保留：消息上记录的 provider 实际就是协议族 */
export type ProviderId = Protocol

export type StopReason = 'stop' | 'toolUse' | 'maxTokens' | 'aborted' | 'error'

export type ShellKind = 'auto' | 'powershell' | 'cmd' | 'bash'

/**
 * 思考强度：与 GLM-5.x 的 reasoning_effort 一一对应（low / high / max）。
 * 其他协议按各自字段映射，模型不支持时会自动退回不传。
 */
export type ThinkingEffort = 'low' | 'high' | 'max'

export interface Usage {
  input: number
  output: number
}

/** 助手输出中的内容块：文本或工具调用。 */
export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export type Block = TextBlock | ToolUseBlock

/** 工具结果的附加信息，供 UI 做差异化渲染（diff、退出码等）。 */
/** 子智能体类型：general 通用 / explore 只读调研 / plan 产出实施计划 */
export type SubagentType = 'general' | 'explore' | 'plan'

export type ToolMeta =
  | { kind: 'bash'; exitCode: number | null; durationMs: number; truncated: boolean; timedOut: boolean }
  | {
      kind: 'task'
      /** 子任务的短标签 */
      label: string
      /** 子智能体类型 */
      type: SubagentType
      /** 子智能体实际跑的模型往返步数 */
      steps: number
      durationMs: number
      inputTokens: number
      outputTokens: number
    }
  | { kind: 'read'; path: string; startLine: number; endLine: number; totalLines: number; truncated: boolean }
  | { kind: 'write'; path: string; bytes: number; created: boolean }
  | { kind: 'edit'; path: string; diff: string; additions: number; removals: number }

/**
 * 用户消息携带的附件。
 * 文件字节由渲染层经 IPC 传入，暂存在数据目录 attachments/<sessionId>/ 下，
 * 消息里只存元数据；构造 provider 请求时按需读取（分支回放同样适用）。
 */
export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  /** image = 作为图片块发给模型；text = 内容内联进文本 */
  kind: 'image' | 'text'
  /** 暂存文件的绝对路径（主进程会校验它必须位于本会话的附件目录内） */
  path: string
}

export interface UserMessage {
  role: 'user'
  id: string
  ts: number
  text: string
  attachments?: Attachment[]
}

export interface AssistantMessage {
  role: 'assistant'
  id: string
  ts: number
  blocks: Block[]
  model: string
  provider: ProviderId
  usage?: Usage
  stopReason: StopReason
  error?: string
}

export interface ToolMessage {
  role: 'tool'
  id: string
  ts: number
  toolCallId: string
  name: string
  /** 原始调用参数，供 UI 展示命令/路径 */
  input?: Record<string, unknown>
  content: string
  isError: boolean
  meta?: ToolMeta
}

export type Message = UserMessage | AssistantMessage | ToolMessage

/** 工具声明，直接喂给 provider 的 tools 参数。 */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

export interface SessionSummary {
  id: string
  title: string
  cwd: string
  createdAt: number
  updatedAt: number
  messageCount: number
  /** 是否置顶（置顶的排在列表最前） */
  pinned?: boolean
}

/** 某条消息在兄弟分支中的位置，用于 UI 的 1/3 切换器。 */
export interface BranchInfo {
  index: number
  count: number
}

export interface SessionView {
  id: string
  title: string
  /** 该会话（项目）绑定的工作目录 */
  cwd: string
  createdAt: number
  updatedAt: number
  leafId: string | null
  /** 该会话绑定的提供商档案；为空表示沿用全局默认 */
  profileId?: string
  /** 该会话绑定的模型；为空表示沿用全局默认 */
  model?: string
  /** 该会话的思考强度；为空表示沿用全局默认 */
  thinking?: ThinkingEffort
  messages: Message[]
  branch: Record<string, BranchInfo>
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/** 从服务商 /models 接口读到的一个模型 */
/** 模型支持的输入模态 */
export type ModelInput = 'text' | 'image' | 'file' | 'audio' | 'video'

export interface ModelOption {
  id: string
  /** 展示名（Anthropic 的 display_name 等） */
  label?: string
  /** 次要说明：owned_by / 创建时间等 */
  hint?: string
  /** 上下文窗口（tokens），来自服务商接口或内置表 */
  contextWindow?: number
  /** 最大输出 tokens */
  maxOutput?: number
  /** 支持的输入模态 */
  inputs?: ModelInput[]
  /** 参数来源：api = 接口返回，catalog = 内置表推断 */
  metaSource?: 'api' | 'catalog'
}

/** 一个提供商档案：同一家厂商的 baseUrl + key + 模型缓存绑定在一起 */
export interface PublicProfile {
  id: string
  label: string
  protocol: Protocol
  baseUrl: string
  hasKey: boolean
  keyProtected: boolean
  /** OAuth 登录状态（只报账号与是否已连接，token 永不出主进程） */
  oauth?: { connected: true; account?: string }
  /** 上次从接口拉到的模型列表，离线时也能选 */
  models: ModelOption[]
  modelsFetchedAt?: number
}

export interface PublicConfig {
  /** 上次选过的目录，仅作为选择器的默认起始位置 */
  lastCwd: string
  activeProfileId: string
  profiles: PublicProfile[]
  model: string
  temperature: number
  /** 输出上限（tokens）；0 表示用服务商默认 */
  maxTokens: number
  shell: ShellKind
  thinking: ThinkingEffort
  lastSessionId?: string
}

export interface ProfilePatch {
  id: string
  label?: string
  protocol?: Protocol
  baseUrl?: string
  apiKey?: string
  clearKey?: boolean
  models?: ModelOption[]
  modelsFetchedAt?: number
}

export interface ConfigPatch {
  activeProfileId?: string
  profiles?: ProfilePatch[]
  model?: string
  temperature?: number
  maxTokens?: number
  shell?: ShellKind
  thinking?: ThinkingEffort
}

export interface ModelListRequest {
  profileId: string
  protocol: Protocol
  baseUrl: string
  /** 未保存的新 key；不传则用已存 key / 环境变量 */
  apiKey?: string
}

/** 定时任务：cron（本地时区 5 段）到点把 prompt 注入指定会话 */
export interface ScheduleTask {
  id: string
  name: string
  cron: string
  prompt: string
  sessionId: string
  enabled: boolean
  createdAt: number
}

/** 跨会话检索的一条命中 */
export interface SessionSearchHit {
  sessionId: string
  title: string
  messageId: string
  role: string
  snippet: string
  ts: number
  score: number
}

export type ModelListResult =
  | { ok: true; models: ModelOption[]; fetchedAt: number }
  | { ok: false; models: ModelOption[]; error: AgentError }

/* ------------------------------------------------------------------ */
/* 插件                                                                */
/* ------------------------------------------------------------------ */

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  enabled: boolean
  /** 该插件注册的工具名 */
  tools: string[]
  dir: string
  /** 加载失败或部分降级时的原因 */
  error?: string
}

/* ------------------------------------------------------------------ */
/* 运行事件                                                            */
/* ------------------------------------------------------------------ */

export interface AgentError {
  kind: 'auth' | 'rate_limit' | 'network' | 'context' | 'server' | 'bad_response' | 'config' | 'unknown'
  message: string
  retryable: boolean
  status?: number
}

export type AgentEvent =
  | { type: 'run_start'; sessionId: string; at: number }
  | { type: 'message_added'; sessionId: string; message: Message }
  | { type: 'assistant_start'; sessionId: string; messageId: string; model: string }
  | { type: 'text_delta'; sessionId: string; messageId: string; delta: string }
  | { type: 'tool_start'; sessionId: string; callId: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_end'; sessionId: string; message: ToolMessage }
  | { type: 'assistant_end'; sessionId: string; message: AssistantMessage }
  | { type: 'steering_queued'; sessionId: string; text: string; pending: number }
  /**
   * 子智能体的工具活动（只用于界面进度反馈，不落盘）。
   * taskCallId 是父会话里 task 工具调用的 id，用于 task 结束时清理。
   */
  | {
      type: 'subagent_tool'
      sessionId: string
      callId: string
      taskCallId: string
      label: string
      name: string
      phase: 'start' | 'end'
    }
  /** 推理模型的思维链增量：只用于界面反馈，不写入会话 */
  | { type: 'thinking_delta'; sessionId: string; messageId: string; delta: string }
  /** 模型发起结构化提问（ask 工具）：渲染层弹卡片，回答经 IPC ask:answer 回填 */
  | { type: 'ask_question'; sessionId: string; callId: string; question: string; options: string[] }
  /** 会话第一次真正开始运行时，自动创建了项目目录 */
  | { type: 'session_cwd'; sessionId: string; cwd: string }
  /** 上下文压缩完成：当前分支已切到摘要新分支，原分支完整保留 */
  | { type: 'session_compacted'; sessionId: string }
  | { type: 'notice'; sessionId: string; level: 'info' | 'warn' | 'error'; text: string }
  /**
   * status:
   * - done    模型不再调用工具，正常收尾
   * - aborted 用户中止（Esc）
   * - stuck   判定为空转（同参数同结果反复），主动停下把控制权交回用户
   * - error   请求或配置错误
   */
  | {
      type: 'run_end'
      sessionId: string
      status: 'done' | 'aborted' | 'stuck' | 'error'
      error?: AgentError
    }

export interface Bootstrap {
  config: PublicConfig
  sessions: SessionSummary[]
  appVersion: string
  platform: string
  dataDir: string
  logsDir: string
  running: string[]
}

export interface SendResult {
  queued: boolean
  message?: Message
}

/** 渲染层通过文件选择框拿到的附件（只有字节与元数据，尚未暂存） */
export interface PickedFile {
  name: string
  mime: string
  bytes: Uint8Array
}

/* ------------------------------------------------------------------ */
/* 工作空间面板                                                          */
/* ------------------------------------------------------------------ */

/** git status --porcelain 的一行：两位状态码 + 相对路径 */
export interface ChangeEntry {
  status: string
  path: string
}

export interface ChangeList {
  /** false = 目录不是 Git 仓库（或 git 不可用） */
  supported: boolean
  files: ChangeEntry[]
}

/** 目录树的一个条目（懒加载，单层列表；符号链接不展开） */
export interface DirEntry {
  name: string
  kind: 'dir' | 'file'
  size: number
}

/** 内嵌终端事件：流式输出 / 进程退出（按 sessionId 过滤） */
export type TermEvent =
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string }

/** 内嵌终端的 shell 类型；auto = 平台默认（Windows 上优先 PowerShell 7，其次 5.1） */
export type TermShellKind = 'auto' | 'powershell' | 'pwsh' | 'cmd' | 'bash'

/* ------------------------------------------------------------------ */
/* 运行轨迹（仿 agent harness 的 trajectory）                          */
/* ------------------------------------------------------------------ */

/** 轨迹中的一次工具往返：assistant 发起 tool_use → tool 返回结果 */
export interface TrajectoryStep {
  toolCallId: string
  name: string
  /** 发起时的参数（命令 / 路径等） */
  input?: Record<string, unknown>
  /** 工具输出（截断后的原文） */
  content: string
  isError: boolean
  meta?: ToolMeta
  durationMs?: number
}

/** 一个回合：一条用户消息到下一条用户消息之间的全部模型活动 */
export interface TrajectoryTurn {
  /** 用户消息 id */
  userId: string
  /** 用户输入（附件以 [附件名] 占位） */
  userText: string
  startedAt: number
  endedAt: number
  /** 模型往返步数（含工具轮） */
  steps: number
  /** 本回合内每次模型响应的列表；每项含文本与工具往返 */
  responses: {
    assistantId: string
    model: string
    text: string
    /** 该响应里的工具调用（含结果，结果消息在其后） */
    toolCalls: TrajectoryStep[]
    usage?: Usage
    stopReason: StopReason
    error?: string
    durationMs: number
  }[]
  inputTokens: number
  outputTokens: number
}

/** 一次子任务运行的完整过程（落盘于 sessions/<id>.subagents.jsonl，按 taskCallId 关联） */
export interface SubagentRun {
  taskCallId: string
  label: string
  type: SubagentType
  startedAt: number
  endedAt: number
  steps: number
  usage: Usage
  isError: boolean
  /** 最终汇报文本 */
  result: string
  /** 子循环的完整消息历史（user / assistant / tool） */
  messages: Message[]
}

export interface Trajectory {
  sessionId: string
  title: string
  cwd: string
  model: string
  createdAt: number
  exportedAt: number
  turns: TrajectoryTurn[]
  totals: { turns: number; steps: number; inputTokens: number; outputTokens: number; durationMs: number }
  /** taskCallId → 子任务完整过程；没有子任务时为空 */
  subProcesses?: Record<string, SubagentRun>
}
