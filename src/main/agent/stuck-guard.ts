/**
 * 空转（stuck）检测。
 *
 * 设计参考主流编码智能体的真实做法（均为源码/官方文档核实）：
 *
 * | 项目 | 判据 | 处置 |
 * | --- | --- | --- |
 * | OpenHands SDK | 同 action + **同 observation**（阈值 4）、action+error（3）、
 * |   | monologue（3）、A→B→A→B 交替（6），窗口按最后一条 user 消息切 | action-error 只 nudge（注入一条 user 消息），
 * |   |   | `is_stuck()` → `execution_status = STUCK` 停止本次 run |
 * | Cline | **按错误**：api_error / invalid_tool_call / tool_execution_failed | 到限后让用户选「换个思路 / 停止」 |
 * | Claude Code | 无内置重复检测 | 只封自己制造的循环（stop hook 连击 8 次、compact thrashing） |
 * | Codex CLI | 无（源码 0 命中轮次/重复检测） | 用户中断 + 上下文窗口 + 审批/sandbox |
 *
 * 两条共同结论：
 * 1. **没人拿步数当闸门**——步数与任务难度无关，是大重构的误杀器。
 * 2. 判据看的是「有没有产生新信息」，并且**分两档**：可恢复的只提醒，铁证无进展的才停。
 *
 * 所以这里只做两件事：nudge（提醒换思路，继续跑）和 stop（结果证明再试也不会变）。
 * 任何情况下都不引入步数上限。
 */

/** 一次工具调用的结果摘要（只保留判定需要的部分） */
export interface Outcome {
  /** 工具名 + 规范化后的参数指纹 */
  key: string
  /** 稳定化后的结果指纹：同 key 同 digest 才叫「没有新信息」 */
  digest: string
  isError: boolean
}

export interface StuckThresholds {
  /** 同参数同结果连续几次开始提醒 */
  nudgeIdentical: number
  /** 同参数同结果连续几次判定为无进展并停止 */
  stopIdentical: number
  /** 连续工具失败几次开始提醒（不看参数是否相同） */
  nudgeFailing: number
  /** A→B→A→B 交替循环连续几次开始提醒 */
  nudgeAlternating: number
}

/**
 * 默认阈值。与主流对齐：
 * - 4 = OpenHands 的 action_observation 阈值（同 action 同 observation 判为卡死）
 * - 3 = OpenHands 的 action_error / Cline 的 maxConsecutiveMistakes
 * - 6 = OpenHands 的 alternating_pattern
 */
export const DEFAULTS: StuckThresholds = {
  nudgeIdentical: 3,
  stopIdentical: 4,
  nudgeFailing: 3,
  nudgeAlternating: 6
}

export type StuckKind = 'identical' | 'failing' | 'alternating'

export interface Verdict {
  /** none = 正常；nudge = 只提醒；stop = 判定空转，结束本次 run */
  action: 'none' | 'nudge' | 'stop'
  kind?: StuckKind
  /** 当前连续次数（用于文案与日志） */
  count: number
  /** 给模型看的提醒正文；action=none 时为空 */
  hint?: string
}

const NONE: Verdict = { action: 'none', count: 0 }

/** 递归按键名排序，保证 { a, b } 与 { b, a } 得到同一个指纹 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key])
    return out
  }
  return value
}

/** 参数的规范化序列化。模型给同一组参数时键序可能不同，排序后比较才不会漏判。 */
export function canonicalInput(input: unknown): string {
  try {
    return JSON.stringify(sortKeys(input ?? {}))
  } catch {
    // 循环引用等异常输入：退回 String，绝不因为检测本身把主流程搞崩
    return String(input)
  }
}

export function callKey(name: string, input: unknown): string {
  return `${name}\u0000${canonicalInput(input)}`
}

/**
 * 结果的稳定化处理。
 *
 * bash 的输出尾部带 `[exit 0 · 0.3s]` 这种我们自己拼的 footer，里面的耗时每次都不同。
 * 不做归一化的话「同一条命令跑两次拿到同样输出」永远被判成「结果不同」，
 * 同参数同结果的判定就永远不触发。这里只抹掉 footer 里的裸耗时字段。
 */
export function stabilizeResult(content: string): string {
  const m = /\n\n\[([^\]]*)\]$/.exec(content)
  if (!m) return content
  const parts = m[1].split(' · ').filter((p) => !/^\d+(?:\.\d+)?s$/.test(p))
  return `${content.slice(0, m.index)}\n\n[${parts.join(' · ')}]`
}

/** 结果指纹。内容可能几百 KB，比较全文代价大，取哈希即可。 */
export function resultDigest(content: string, isError: boolean): string {
  const normalized = stabilizeResult(content)
  // 简单 FNV-1a：够用、无依赖、对超大字符串也很快
  let hash = 0x811c9dc5
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${isError ? 'E' : 'O'}:${normalized.length}:${hash.toString(16)}`
}

/** 末尾连续满足 predicate 的长度 */
function trailingRun<T>(items: T[], predicate: (item: T) => boolean): number {
  let n = 0
  for (let i = items.length - 1; i >= 0 && predicate(items[i]); i--) n++
  return n
}

function sameOutcome(a: Outcome, b: Outcome): boolean {
  return a.key === b.key && a.digest === b.digest
}

/**
 * 判定当前是否空转。纯函数：给定同一段 history 永远得到同一结论，方便单测。
 *
 * 优先级：stop > nudge。stop 的判据只有一条——**同参数 + 同结果**连续到阈值，
 * 这是唯一「再试一次也不会变」的铁证；其余模式都只提醒，交回给模型决定。
 */
export function assess(history: Outcome[], thresholds: Partial<StuckThresholds> = {}): Verdict {
  const t = { ...DEFAULTS, ...thresholds }
  if (!history.length) return NONE

  const last = history[history.length - 1]

  // 1) 同参数同结果：铁证无进展 → 停止
  const identicalCount = trailingRun(history, (o) => sameOutcome(o, last))
  if (identicalCount >= t.stopIdentical) {
    return {
      action: 'stop',
      kind: 'identical',
      count: identicalCount,
      hint: identicalHint(last.key, identicalCount, true)
    }
  }

  // 2) 同参数同结果未到停止线：先提醒
  if (identicalCount >= t.nudgeIdentical && identicalCount % t.nudgeIdentical === 0) {
    return {
      action: 'nudge',
      kind: 'identical',
      count: identicalCount,
      hint: identicalHint(last.key, identicalCount, false)
    }
  }

  // 3) 连续失败：不看参数是否相同（Cline 的维度——换了参数仍然连续失败也是卡住）
  const failingCount = trailingRun(history, (o) => o.isError)
  if (failingCount >= t.nudgeFailing && failingCount % t.nudgeFailing === 0) {
    return { action: 'nudge', kind: 'failing', count: failingCount, hint: failingHint(failingCount) }
  }

  // 4) A→B→A→B 交替循环：两个结果都各自重复，整体在原地打转
  const alternatingCount = periodTwoRun(history)
  if (alternatingCount >= t.nudgeAlternating && alternatingCount % t.nudgeAlternating === 0) {
    return {
      action: 'nudge',
      kind: 'alternating',
      count: alternatingCount,
      hint: alternatingHint(history, alternatingCount)
    }
  }

  return NONE
}

/**
 * 末尾满足「与往前两步完全相同」的**元素个数**（A→B→A→B…）。
 *
 * 循环里每个匹配的位置贡献 1，但最早的那两个元素（i 减到 2 时对应的 i 与 i-2）
 * 本身也属于这个循环 —— 所以真实长度是匹配数 + 2。
 * 例：[A,B,A,B] 匹配 2 次 → 长度 4；[A,B,A,B,A,B] 匹配 4 次 → 长度 6。
 */
function periodTwoRun(history: Outcome[]): number {
  let matched = 0
  for (let i = history.length - 1; i >= 2; i--) {
    if (!sameOutcome(history[i], history[i - 2])) break
    matched++
  }
  return matched === 0 ? 0 : matched + 2
}

function toolNameOf(key: string): string {
  const cut = key.indexOf('\u0000')
  return cut > 0 ? key.slice(0, cut) : key
}

function identicalHint(key: string, count: number, stop: boolean): string {
  const tool = toolNameOf(key)
  const head = stop
    ? `[空转判定] ${tool} 已经连续 ${count} 次用完全相同的参数得到完全相同的结果。`
    : `[重复调用提醒] 这是连续第 ${count} 次用完全相同的参数调用 ${tool}，且结果没有变化。`
  const body = stop
    ? '再试一次也不会得到新信息，本次运行到此为止。请换一种思路，或直接告诉用户卡在哪里。'
    : '如果这一步本来就不会产生新信息，换一种做法（改参数 / 换工具 / 先读报错），或者停下来向用户说明卡在哪里。此提醒不中断运行，下一步怎么做由你决定。'
  return `${head}${body}`
}

function failingHint(count: number): string {
  return (
    `[连续失败提醒] 最近 ${count} 次工具调用都失败了（即使换了参数）。` +
    '先把报错读清楚：确认路径/命令/参数是否真的对，再决定下一步；' +
    '反复用同一类方式重试不会让错误消失。此提醒不中断运行。'
  )
}

function alternatingHint(history: Outcome[], count: number): string {
  const a = toolNameOf(history[history.length - 2].key)
  const b = toolNameOf(history[history.length - 1].key)
  return (
    `[循环提醒] 最近 ${count} 步在 ${a} 与 ${b} 之间反复交替，且每次结果都一样——` +
    '这通常意味着验证没有带来新信息。要么换一个检查角度，要么直接推进下一步；' +
    '此提醒不中断运行。'
  )
}
