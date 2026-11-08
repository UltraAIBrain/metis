import type {
  AgentError,
  AgentEvent,
  SubagentRun,
  SubagentType,
  AssistantMessage,
  Block,
  Message,
  SendResult,
  ToolMessage,
  ToolUseBlock
} from '@shared/types'
import { appendFileSync, existsSync } from 'node:fs'
import type { ConfigStore } from '../config'
import type { Logger } from '../logger'
import { lookupModel } from '../../shared/model-catalog'
import { buildSystemPrompt } from './prompt'
import { newId, type SessionStore } from './session'
import { toolSpecs, executeTool, type ToolResult } from './tools'
import { createProvider, streamWithRetry, type StreamResult } from './providers'
import { AgentFailure, describeFailure, failureHint } from './errors'
import { sanitizeToolPairing } from './sanitize'
import { isLocalHost } from '../../shared/providers'
import { resolveBearer } from '../oauth'
import { consumeNudge, noteRunEnd } from './memory-store'
import { pluginHost } from '../plugins'
import { ensureProjectDir } from '../projects'
import { paths } from '../paths'
import { validAttachmentsFor } from '../attachments'
import { assess, callKey, resultDigest, type Outcome } from './stuck-guard'
import { assessBudget, type BudgetState } from './budget-guard'

/** 子过程落盘时工具输出的回放截断（回放够用，防单行 JSON 数 MB） */
const SUB_TOOL_CLIP = 8_000

/**
 * 把守卫给出的提示追加到 tool 结果末尾，而不是单独发一条消息——
 * 这样它就在模型下一步必然读到的位置，又不破坏 tool_use / tool_result 的配对结构。
 */
function withHint(content: string, hint?: string): string {
  return hint ? `${content}\n\n---\n${hint}` : content
}

/** 给用户的提示：说明发生了什么、已经做了什么、用户能怎么接管 */
function stuckNoticeText(kind: string | undefined, count: number): string {
  const what =
    kind === 'failing'
      ? `连续 ${count} 次工具调用都失败`
      : kind === 'alternating'
        ? `最近 ${count} 步在两个动作之间反复交替`
        : `同一调用连续 ${count} 次拿到完全相同的输出`
  return `检测到 ${what}，已提示模型换思路。若它继续原地打转，可以按 Esc 中止后自己接手。`
}

/** 上下文压缩的总结提示词：产出结构化摘要，供新分支继续工作 */
const COMPACT_SYSTEM = [
  '你是会话压缩器。把这段开发者对话压缩成一份**给下一个接手的 agent 看的工作摘要**，用中文，不超过 1200 字，按以下结构输出：',
  '1. 任务目标：用户想完成什么（含原始关键要求）',
  '2. 已完成：做了哪些改动（文件路径 + 一句话说明）',
  '3. 关键决策与约定：用户明确同意 / 否决过什么，后续必须遵守的偏好',
  '4. 未完成与下一步：还剩什么，进行到哪一步',
  '5. 重要状态：环境、路径、正在运行的东西、已知的坑',
  '只输出摘要正文，不要客套。文件路径、命令、报错关键句原样保留。'
].join('\n')

interface ActiveRun {
  sessionId: string
  abort: AbortController
  queue: string[]
  startedAt: number
  /**
   * 本次 run 内的工具结果窗口（空转检测用）。
   * 有新的用户消息注入时清空——与 OpenHands「按最后一条 user 消息切窗口」一致。
   */
  outcomes?: Outcome[]
  /** 上下文预算提醒的投递状态（对齐 Codex 的 reminder_index：每个阈值只提醒一次） */
  budget?: BudgetState
}

/**
 * 代理运行时：负责"一次持续对话"的生命周期。
 * - 串行工具执行，保证文件操作的可预测性
 * - 运行中收到的消息进入队列，在下一步开始前注入（steering）
 * - 任何中断都会为已发出的 tool_use 补一个结果，避免会话结构损坏
 */
export class AgentRunner {
  private active = new Map<string, ActiveRun>()

  constructor(
    private sessions: SessionStore,
    private config: ConfigStore,
    private log: Logger,
    private emit: (e: AgentEvent) => void
  ) {}

  runningIds(): string[] {
    return [...this.active.keys()]
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId)
  }

  send(sessionId: string, raw: string, rawAttachments?: unknown): SendResult {
    const text = raw.trim()
    if (!text && !(rawAttachments as unknown[] | undefined)?.length) throw new Error('消息不能为空')
    if (!this.sessions.exists(sessionId)) throw new Error('会话不存在或已被删除')

    const running = this.active.get(sessionId)
    if (running) {
      // 排队中的消息同样可能带附件：把暂存校验放在入队前，出错时直接拒绝而不是烂在队列里
      const attachments = validAttachmentsFor(sessionId, rawAttachments)
      running.queue.push(JSON.stringify({ text, attachments }))
      this.emit({
        type: 'steering_queued',
        sessionId,
        text: text || `（${attachments?.length ?? 0} 个附件）`,
        pending: running.queue.length
      })
      this.log.info('run.steering', { sessionId, pending: running.queue.length, attachments: attachments?.length ?? 0 })
      return { queued: true }
    }

    const attachments = validAttachmentsFor(sessionId, rawAttachments)
    const message: Message = { role: 'user', id: newId('u'), ts: Date.now(), text, attachments }
    this.sessions.append(sessionId, message)
    this.emit({ type: 'message_added', sessionId, message })

    const run: ActiveRun = { sessionId, abort: new AbortController(), queue: [], startedAt: Date.now() }
    this.active.set(sessionId, run)
    void this.loop(run)
    return { queued: false, message }
  }

  abort(sessionId: string): void {
    const run = this.active.get(sessionId)
    if (!run) return
    this.log.info('run.abort_requested', { sessionId })
    run.abort.abort()
  }

  /**
   * 上下文压缩：把当前分支整段交给模型总结，摘要作为**新分支的根**（appendRoot）。
   * 原对话分支完整保留（分支切换可回看），新分支从摘要继续——不偷偷改历史。
   */
  async compact(sessionId: string): Promise<void> {
    if (!this.sessions.exists(sessionId)) throw new Error('会话不存在或已被删除')
    if (this.active.has(sessionId)) throw new Error('任务运行中，请等结束后再压缩。')

    const cfg = this.config.load()
    const meta = this.sessions.meta(sessionId)
    const pinned = meta.profileId ? this.config.profileById(meta.profileId) : undefined
    const profile = pinned ?? this.config.activeProfile()
    const model = meta.model?.trim() || cfg.model
    if (!model) throw new AgentFailure('config', '当前会话还没有选择模型，无法压缩。')

    const history = this.sessions.view(sessionId).messages
    if (history.length < 2) throw new AgentFailure('config', '会话内容太少，无需压缩。')

    const bearer = await resolveBearer(this.config, profile)
    if (!bearer && !isLocalHost(profile.baseUrl)) {
      throw new AgentFailure('config', `「${profile.label}」还没有配置凭据，无法压缩。`)
    }
    const provider = createProvider(profile.protocol, profile.baseUrl, bearer, (event, data) =>
      this.log.info(event, data)
    )

    this.emit({ type: 'notice', sessionId, level: 'info', text: '正在压缩上下文（总结当前分支）…' })
    const result = await streamWithRetry(
      provider,
      {
        system: COMPACT_SYSTEM,
        messages: history,
        tools: [],
        model,
        temperature: 0.2,
        thinking: 'low',
        maxTokens: 4000,
        signal: new AbortController().signal,
        onTextDelta: () => {}
      },
      (event, data) => this.log.info(event, data)
    )
    const text = result.blocks
      .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) throw new AgentFailure('bad_response', '压缩失败：模型没有返回摘要。')

    const summary: Message = {
      role: 'user',
      id: newId('u'),
      ts: Date.now(),
      text: `[上下文压缩摘要 · ${new Date().toLocaleString('zh-CN')}]\n\n以下是此前对话的自动摘要；完整原对话保留在另一条分支上（在最早的助手消息处用 ‹ › 可切回）：\n\n${text}`
    }
    this.sessions.appendRoot(sessionId, summary)
    this.log.info('session.compacted', { sessionId, fromMessages: history.length, summaryChars: text.length })
    this.emit({ type: 'session_compacted', sessionId })
    this.emit({
      type: 'notice',
      sessionId,
      level: 'info',
      text: `上下文已压缩：${history.length} 条消息 → 摘要分支（原分支保留）`
    })
  }

  abortAll(): void {
    for (const run of this.active.values()) run.abort.abort()
  }

  private async loop(run: ActiveRun): Promise<void> {
    const { sessionId } = run
    const cfg = this.config.load()
    // 记忆 nudge：上一轮"用过工具但没记任何东西"时，本轮 system 提醒一次（消费即清零）
    const nudge = consumeNudge()
    /** 本轮是否用过工具（run 结束后喂给 memory-store 决定是否设置 nudge） */
    let usedTools = false
    const historyForQuery = (id: string): { role: string; text?: string }[] =>
      this.sessions.view(id).messages as { role: string; text?: string }[]
    // 会话可以绑定自己的提供商与模型；未绑定则沿用全局默认
    const meta = this.sessions.meta(sessionId)
    const pinned = meta.profileId ? this.config.profileById(meta.profileId) : undefined
    const profile = pinned ?? this.config.activeProfile()
    const model = meta.model?.trim() || cfg.model
    // 思考强度同理：会话绑定优先，其次全局默认
    const thinking = meta.thinking ?? cfg.thinking
    // 输出上限：手填优先；否则用模型自己的能力值（接口返回 > 内置表 > 兜底 16384）
    const cachedMax = profile.models?.find((m) => m.id === model)?.maxOutput
    const autoMax = cachedMax ?? lookupModel(model)?.maxOutput ?? 16384
    const maxTokens = cfg.maxTokens > 0 ? cfg.maxTokens : autoMax
    // 上下文预算提醒的分母：接口给的窗口优先，其次内置表（与状态栏 contextWindowOf 同口径）
    const budgetWindow =
      profile.models?.find((m) => m.id === model)?.contextWindow ?? lookupModel(model)?.contextWindow
    // 工作目录属于会话（项目）；允许创建时为空，真正开跑时再懒创建
    let cwd = meta.cwd
    if (!cwd) {
      try {
        cwd = ensureProjectDir()
        this.sessions.setCwd(sessionId, cwd)
        meta.cwd = cwd
        this.emit({ type: 'session_cwd', sessionId, cwd })
        this.log.info('project.auto_created', { sessionId, cwd })
      } catch (err) {
        this.log.error('project.create_failed', err)
      }
    }
    const providerId = profile.protocol
    let status: 'done' | 'aborted' | 'error' = 'done'
    let failure: AgentError | undefined
    let steps = 0
    /** 最近一次响应的 input token（下一次请求的基数），预算提醒用它算剩余比例 */
    let lastUsageInput = 0
    this.emit({ type: 'run_start', sessionId, at: Date.now() })
    this.log.info('run.start', {
      sessionId,
      profile: profile.id,
      provider: providerId,
      model,
      modelPinned: Boolean(meta.profileId || meta.model),
      thinking,
      cwd,
      shell: cfg.shell,
      maxTokens
    })

    try {
      if (!cwd) {
        throw new AgentFailure('config', '这个项目还没有工作目录，请重新选择。')
      }
      if (!existsSync(cwd)) {
        throw new AgentFailure('config', `工作目录不存在：${cwd}。请重新选择这个项目的目录。`)
      }
      if (!model) {
        throw new AgentFailure('config', '当前会话还没有选择模型，请先在顶栏或设置里选一个。')
      }
      // 凭据解析：OAuth 档案用 access token（过期自动刷新并写回），其余走 API Key / 环境变量
      const bearer = await resolveBearer(this.config, profile)
      if (!bearer && !isLocalHost(profile.baseUrl)) {
        throw new AgentFailure(
          'config',
          `「${profile.label}」还没有配置凭据：${
            profile.protocol === 'responses' ? '请在 设置 → 模型服务 里用 OpenAI 登录' : '请在 设置 → 模型服务 中填写 API Key'
          }。`
        )
      }
      const provider = createProvider(providerId, profile.baseUrl, bearer, (event, data) => this.log.info(event, data))

      for (;;) {
        // 运行中被追加的用户消息，在这里注入为新的 user turn（队列元素是 {text, attachments} 的 JSON）
        while (run.queue.length) {
          const raw = JSON.parse(run.queue.shift() as string) as { text: string; attachments?: unknown }
          const injected: Message = {
            role: 'user',
            id: newId('u'),
            ts: Date.now(),
            text: raw.text,
            attachments: validAttachmentsFor(sessionId, raw.attachments)
          }
          this.sessions.append(sessionId, injected)
          this.emit({ type: 'message_added', sessionId, message: injected })
          this.log.info('run.inject_steering', { sessionId })
          // 用户补充了新信息，之前的空转计数作废（窗口按最后一条 user 消息切）
          run.outcomes = []
        }

        if (run.abort.signal.aborted) {
          status = 'aborted'
          break
        }
        steps++

        // 每步重建系统提示词：memory append / AGENTS.md / 技能变更在本次 run 内的后续步骤立即可见。
        // 成本只是每步读几个小文件，远小于把它缓存整个 run 的陈旧性代价。
        // userQuery = 当前最后一条用户消息：超限后的记忆按它检索注入；nudge 在 run 开始时消费一次。
        const lastUser = [...historyForQuery(sessionId)].reverse().find((m) => m.role === 'user') as
          | { text?: string }
          | undefined
        const system = buildSystemPrompt(cwd, pluginHost.instructions(), {
          userQuery: lastUser?.text ?? '',
          nudge
        })

        const history = sanitizeToolPairing(this.sessions.view(sessionId).messages)
        const messageId = newId('a')
        this.emit({ type: 'assistant_start', sessionId, messageId, model })

        let partial = ''
        let result: StreamResult | null = null
        let lastError: unknown = null

        const attempt = (effort: typeof thinking): Promise<StreamResult> =>
          streamWithRetry(
            provider,
            {
              system,
              messages: history,
              tools: toolSpecs(),
              model,
              temperature: cfg.temperature,
              maxTokens,
              thinking: effort,
              signal: run.abort.signal,
              onTextDelta: (delta) => {
                partial += delta
                this.emit({ type: 'text_delta', sessionId, messageId, delta })
              },
              onThinkingDelta: (delta) => {
                this.emit({ type: 'thinking_delta', sessionId, messageId, delta })
              }
            },
            (event, data) => this.log.info(event, data)
          )

        try {
          result = await attempt(thinking)
        } catch (err) {
          // 思考把输出额度吃完了：降到低强度再试一次，通常能在同一预算内给出正文
          const budget = err instanceof AgentFailure && err.code === 'reasoning_budget'
          if (budget && thinking !== 'low' && !run.abort.signal.aborted) {
            this.log.warn('run.reasoning_retry', { sessionId, from: thinking, maxTokens })
            this.emit({
              type: 'notice',
              sessionId,
              level: 'warn',
              text: `模型把输出额度耗在了思考上，已自动降到「低」重试一次（输出上限 ${maxTokens}）。`
            })
            try {
              result = await attempt('low')
            } catch (retryErr) {
              lastError = retryErr
            }
          } else {
            lastError = err
          }
        }

        if (!result) {
          const blocks: Block[] = partial ? [{ type: 'text', text: partial }] : []
          if (run.abort.signal.aborted) {
            const aborted: AssistantMessage = {
              role: 'assistant',
              id: messageId,
              ts: Date.now(),
              blocks,
              model,
              provider: providerId,
              stopReason: 'aborted'
            }
            this.sessions.append(sessionId, aborted)
            this.emit({ type: 'assistant_end', sessionId, message: aborted })
            status = 'aborted'
          } else {
            const ae = describeFailure(lastError)
            const hint = failureHint(ae.kind)
            const failed: AssistantMessage = {
              role: 'assistant',
              id: messageId,
              ts: Date.now(),
              blocks,
              model,
              provider: providerId,
              stopReason: 'error',
              error: `${ae.message}\n\n${hint}`
            }
            this.sessions.append(sessionId, failed)
            this.emit({ type: 'assistant_end', sessionId, message: failed })
            this.emit({ type: 'notice', sessionId, level: 'error', text: hint })
            this.log.error('run.provider_error', ae)
            status = 'error'
            failure = ae
          }
          break
        }

        const assistant: AssistantMessage = {
          role: 'assistant',
          id: messageId,
          ts: Date.now(),
          blocks: result.blocks,
          model,
          provider: providerId,
          usage: result.usage,
          stopReason: result.stopReason
        }
        this.sessions.append(sessionId, assistant)
        this.emit({ type: 'assistant_end', sessionId, message: assistant })

        if (result.usage) {
          this.log.info('run.usage', { sessionId, step: steps, ...result.usage })
          lastUsageInput = result.usage.input
        }

        const toolUses = result.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
        if (toolUses.length) {
          // 子智能体执行器：独立消息历史，复用父的 provider / 模型 / 工作目录 / 中止信号。
          // 定义成闭包而不是类方法，省去把 provider、system、cfg 一路传参。
          const subLoop = async (
            prompt: string,
            label: string,
            taskCallId: string,
            type: SubagentType
          ): Promise<ToolResult> => {
            const startedAt = Date.now()
            const usage = { input: 0, output: 0 }
            // 子过程落盘：每个 task 一行追加到 <id>.subagents.jsonl，供轨迹导出与事后回放。
            // 写失败只记日志——回放是辅助能力，不能因为它影响任务本身。
            const persist = (done: boolean, resultText: string, endedAt: number): void => {
              try {
                // 子过程记录用于回放，不需要逐字节还原：工具输出按 8KB 截断，
                // 否则 24 步 × 200KB 的 bash 输出能把单行 JSON 撑到数 MB（导出时全量读入）
                const clipped = history.map((m): Message => {
                  if (m.role !== 'tool' || m.content.length <= SUB_TOOL_CLIP) return m
                  return { ...m, content: `${m.content.slice(0, SUB_TOOL_CLIP)}\n…（回放记录已截断至 8KB；子任务的完整输出只存在于其运行时上下文）` }
                })
                const record: SubagentRun = {
                  taskCallId,
                  label,
                  type,
                  startedAt,
                  endedAt,
                  steps,
                  usage: { input: usage.input, output: usage.output },
                  isError: !done,
                  result: resultText,
                  messages: clipped
                }
                appendFileSync(paths.subagents(sessionId), `${JSON.stringify(record)}\n`, 'utf8')
              } catch (err) {
                this.log.warn('tool.subtask_persist_failed', { sessionId, taskCallId, err: String(err) })
              }
            }
            const stat = (done: boolean, content: string): ToolResult => {
              const endedAt = Date.now()
              persist(done, content, endedAt)
              return {
                content,
                isError: !done,
                meta: {
                  kind: 'task',
                  label,
                  type,
                  steps,
                  durationMs: endedAt - startedAt,
                  inputTokens: usage.input,
                  outputTokens: usage.output
                }
              }
            }
            const history: Message[] = [{ role: 'user', id: newId('u'), ts: Date.now(), text: prompt }]
            let steps = 0
            /** 子智能体自己的结果窗口，与父循环互不影响 */
            const subOutcomes: Outcome[] = []
            const subTools = toolSpecs({ forSubAgent: true, subagentType: type })
            const allowedTools = new Set(subTools.map((tool) => tool.name))
            // 子智能体的系统提示词：主提示词 + 按类型的身份说明
            const typeBrief =
              type === 'explore'
                ? 'You are a READ-ONLY exploration sub-agent: investigate and report findings using read/repomind/fetch/ask. You have no shell or write tools; do not attempt to modify anything.'
                : type === 'plan'
                  ? 'You are a PLANNING sub-agent: produce a concrete, step-by-step implementation plan (files to touch, changes to make, how to verify). Investigate with read/repomind/fetch/ask. Do NOT modify anything; you have no shell or write tools.'
                  : 'Work autonomously with the tools you have.'
            const subSystem = `${system}\n\n## Sub-agent mode\nYou are a SUB-AGENT spawned by the main agent for one independent sub-task ("${label}"). ${typeBrief} When done, reply with a concise text summary of your findings or results — it is returned to the main agent as a tool result. You do NOT have the task tool and cannot spawn further sub-agents.`

            for (;;) {
              if (run.abort.signal.aborted) return stat(false, '子任务已随主任务中止。')
              steps++

              let result: StreamResult
              try {
                result = await streamWithRetry(
                  provider,
                  {
                    system: subSystem,
                    messages: history,
                    tools: subTools,
                    model,
                    temperature: cfg.temperature,
                    maxTokens,
                    thinking,
                    signal: run.abort.signal,
                    // 子过程不上屏：界面只看到 task 工具在执行，避免两个"正在生成"气泡
                    onTextDelta: () => {}
                  },
                  (event, data) => this.log.info(event, data)
                )
              } catch (err) {
                const ae = describeFailure(err)
                this.log.warn('tool.subtask_failed', { sessionId, label, message: ae.message })
                return stat(false, `子任务执行失败：${ae.message}`)
              }

              history.push({
                role: 'assistant',
                id: newId('a'),
                ts: Date.now(),
                blocks: result.blocks,
                model,
                provider: providerId,
                usage: result.usage,
                stopReason: result.stopReason
              })
              if (result.usage) {
                usage.input += result.usage.input
                usage.output += result.usage.output
              }

              const calls = result.blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')
              if (!calls.length) {
                const text = result.blocks
                  .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n')
                this.log.info('tool.subtask_done', { sessionId, label, steps, ...usage })
                return stat(true, text || '（子任务完成，但没有文本汇报）')
              }

              for (const call of calls) {
                if (run.abort.signal.aborted) {
                  // 中止后剩余的 tool_use 也要有结果，否则落盘的子历史存在未配对调用，无法直接重放
                  history.push({
                    role: 'tool',
                    id: newId('t'),
                    ts: Date.now(),
                    toolCallId: call.id,
                    name: call.name,
                    input: call.input,
                    content: '已中止：用户中断了本次运行。',
                    isError: true
                  })
                  continue
                }
                // 进度反馈：子任务的工具活动实时上屏（不落盘），否则长任务只有一个 spinner，像卡死
                this.emit({
                  type: 'subagent_tool',
                  sessionId,
                  callId: call.id,
                  taskCallId,
                  label,
                  name: call.name,
                  phase: 'start'
                })
                const raw = await executeTool(call.name, call.input, {
                  workspace: cwd,
                  shell: cfg.shell,
                  signal: run.abort.signal,
                  allowedTools,
                  sessionId,
                  callId: call.id,
                  log: (event, data) => this.log.info(event, data)
                  // 刻意不传 spawnSubAgent：子智能体不能再派生
                })
                subOutcomes.push({
                  key: callKey(call.name, call.input),
                  digest: resultDigest(raw.content, raw.isError),
                  isError: raw.isError
                })
                const verdict = assess(subOutcomes)
                if (verdict.hint) {
                  this.log.warn('tool.stuck_detected', {
                    sessionId,
                    subagent: label,
                    kind: verdict.kind,
                    count: verdict.count
                  })
                }
                const out = { ...raw, content: withHint(raw.content, verdict.hint) }
                this.emit({
                  type: 'subagent_tool',
                  sessionId,
                  callId: call.id,
                  taskCallId,
                  label,
                  name: call.name,
                  phase: 'end'
                })
                history.push({
                  role: 'tool',
                  id: newId('t'),
                  ts: Date.now(),
                  toolCallId: call.id,
                  name: call.name,
                  input: call.input,
                  content: out.content,
                  isError: out.isError,
                  meta: out.meta
                })
              }
            }
          }

          /** 单个工具调用的完整生命周期：发事件 → 执行 → 落盘 → 发结束事件 */
          const runOneTool = async (call: ToolUseBlock, allowSpawn: boolean): Promise<ToolMessage> => {
            if (run.abort.signal.aborted) {
              const cancelled = this.cancelledResult(call)
              this.sessions.append(sessionId, cancelled)
              this.emit({ type: 'tool_end', sessionId, message: cancelled })
              return cancelled
            }

            this.emit({ type: 'tool_start', sessionId, callId: call.id, name: call.name, input: call.input })
            const started = Date.now()
            usedTools = true

            const raw = await executeTool(call.name, call.input, {
              workspace: cwd,
              shell: cfg.shell,
              signal: run.abort.signal,
              log: (event, data) => this.log.info(event, data),
              sessionId,
              callId: call.id,
              // 只允许主循环派生子智能体（allowSpawn 由调用方按场景传）
              spawnSubAgent: allowSpawn ? subLoop : undefined
            })

            run.outcomes = run.outcomes ?? []
            run.outcomes.push({
              key: callKey(call.name, call.input),
              digest: resultDigest(raw.content, raw.isError),
              isError: raw.isError
            })
            // 空转判定：只提醒，不中止（Codex / Claude Code 都不做行为级硬停）。
            // 判据是「有没有产生新信息」，不是步数。
            const verdict = assess(run.outcomes)
            if (verdict.hint) {
              this.log.warn('tool.stuck_detected', {
                sessionId,
                tool: call.name,
                kind: verdict.kind,
                count: verdict.count
              })
              this.emit({
                type: 'notice',
                sessionId,
                level: 'warn',
                text: stuckNoticeText(verdict.kind, verdict.count)
              })
            }

            // 上下文预算提醒（Codex RolloutBudget 的做法）：真正的硬约束是窗口，
            // 与其数步数，不如把「还剩多少」直接告诉模型，由它自己收尾。
            const budget = assessBudget(lastUsageInput, budgetWindow, run.budget)
            run.budget = budget.state
            if (budget.remind) {
              this.log.warn('budget.reminder', {
                sessionId,
                index: budget.index,
                usedInput: lastUsageInput,
                window: budgetWindow
              })
              this.emit({
                type: 'notice',
                sessionId,
                level: 'info',
                text: `上下文已用约 ${Math.round((1 - (budget.remainingRatio ?? 0)) * 100)}%，已提醒模型收着做；可随时手动压缩。`
              })
            }
            const out = {
              ...raw,
              content: withHint(withHint(raw.content, verdict.hint), budget.hint)
            }

            const toolMessage: ToolMessage = {
              role: 'tool',
              id: newId('t'),
              ts: Date.now(),
              toolCallId: call.id,
              name: call.name,
              input: call.input,
              content: out.content,
              isError: out.isError,
              meta: out.meta
            }
            this.sessions.append(sessionId, toolMessage)
            this.emit({ type: 'tool_end', sessionId, message: toolMessage })
            this.log.info('tool.done', {
              sessionId,
              tool: call.name,
              ok: !out.isError,
              ms: Date.now() - started
            })
            return toolMessage
          }

          // 同一轮全是 task 调用时并行跑：多个独立子任务不必互相等。
          // 混合轮次（task 与文件/命令混排）仍串行，保持文件操作的可预测性。
          if (toolUses.length > 1 && toolUses.every((c) => c.name === 'task')) {
            await Promise.all(toolUses.map((call) => runOneTool(call, true)))
          } else {
            for (const call of toolUses) {
              await runOneTool(call, true)
            }
          }

          if (run.abort.signal.aborted) {
            status = 'aborted'
            break
          }
          continue
        }

        if (result.stopReason === 'maxTokens') {
          this.emit({
            type: 'notice',
            sessionId,
            level: 'warn',
            text: '输出达到模型长度上限已截断。可回复"继续"让模型接着写。'
          })
        }

        // 没有工具调用：若队列里没有新消息，本轮结束
        if (run.queue.length === 0) break
      }
    } catch (err) {
      failure = describeFailure(err)
      status = 'error'
      // 配置类错误要给出具体原因，"配置不完整"这种提示帮不上忙
      const text = failure.kind === 'config' ? failure.message : failureHint(failure.kind)
      this.emit({ type: 'notice', sessionId, level: 'error', text })
      this.log.error('run.failed', failure)
    } finally {
      // 中止瞬间队列里可能还有用户已发过的消息：不能静默丢弃（UI 已提示"已排队"），
      // 把它们注入落盘为正式消息，用户下次发消息时模型就能看到。
      const leftover = run.queue.splice(0)
      if (run.abort.signal.aborted) {
        for (const raw of leftover) {
          try {
            const parsed = JSON.parse(raw) as { text: string; attachments?: unknown }
            const kept: Message = {
              role: 'user',
              id: newId('u'),
              ts: Date.now(),
              text: parsed.text,
              attachments: validAttachmentsFor(sessionId, parsed.attachments)
            }
            this.sessions.append(sessionId, kept)
            this.emit({ type: 'message_added', sessionId, message: kept })
          } catch (err) {
            this.log.warn('run.leftover_persist_failed', { sessionId, err: String(err) })
          }
        }
        if (leftover.length) {
          this.emit({
            type: 'notice',
            sessionId,
            level: 'warn',
            text: `已中止。排队中的 ${leftover.length} 条消息已保留在会话里，继续发送即可处理。`
          })
        }
      }
      this.active.delete(sessionId)
      // 记忆 nudge 状态回写：用过工具但全程没写记忆 → 下一轮 system 提醒一次
      noteRunEnd(usedTools)

      this.emit({ type: 'run_end', sessionId, status, error: failure })
      this.log.info('run.end', {
        sessionId,
        status,
        steps,
        ms: Date.now() - run.startedAt,
        leftover: leftover.length
      })

      if (leftover.length && !run.abort.signal.aborted) {
        const next: ActiveRun = {
          sessionId,
          abort: new AbortController(),
          queue: leftover,
          startedAt: Date.now()
        }
        this.active.set(sessionId, next)
        void this.loop(next)
      }
    }
  }

  private cancelledResult(call: ToolUseBlock): ToolMessage {
    return {
      role: 'tool',
      id: newId('t'),
      ts: Date.now(),
      toolCallId: call.id,
      name: call.name,
      input: call.input,
      content: '已中止：用户中断了本次运行。',
      isError: true
    }
  }
}
