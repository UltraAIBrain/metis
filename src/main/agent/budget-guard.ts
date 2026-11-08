/**
 * 上下文预算提醒（对齐 OpenAI Codex 的 RolloutBudget）。
 *
 * Codex 的 `core/src/rollout_budget.rs` 是这么做的：
 *
 * ```rust
 * pub struct RolloutBudgetReminder {
 *     pub remaining_tokens: i64,
 *     /// Backend-defined reminder position, returned unchanged on acknowledgement.
 *     pub reminder_index: i64,
 * }
 * // reminder_at_remaining_tokens: 多个阈值
 * let reminder_index = config.reminder_at_remaining_tokens
 *     .iter().filter(|&&t| remaining_tokens <= t).count();
 * ```
 *
 * 要点：
 * 1. 阈值是**一组**，不是单个；`reminder_index` = 「已经跨过了几个阈值」，保证每个阈值只提醒一次。
 * 2. 默认是**提醒**，不是硬停——只有 `enforce_limit` 打开才真拦。
 * 3. 提醒是在 history 插入之后才标记投递的（取消的请求应该重投）。
 *
 * 这是 Codex / Claude Code 这类一流智能体真正的「防失控」抓手：
 * 不是数步数、不是检测重复，而是**让模型知道自己还剩多少上下文**，
 * 由它自己决定什么时候收尾——上下文窗口才是唯一真实存在的硬约束。
 */

/**
 * 剩余比例降到这些值以下时各提醒一次（从大到小）。
 * 与 Codex 的 `reminder_at_remaining_tokens` 同构，只是这里用比例，
 * 因为同一套逻辑要跨 8K～1M 各种窗口。
 *
 * 50% / 25% / 10% 剩余 ≈ 已用 50% / 75% / 90%，
 * 与状态栏的 warn / hot 阈值（75% / 90%）对齐。
 */
export const BUDGET_THRESHOLDS: number[] = [0.5, 0.25, 0.1]

/** 一个 run 内的投递状态；与 Codex 的 `ThreadBudgetDelivery` 同构 */
export interface BudgetState {
  /** 已经投递到第几个阈值（0 = 一个都没投） */
  delivered: number
}

export interface BudgetVerdict {
  /** 更新后的状态，调用方负责存回去 */
  state: BudgetState
  /** 剩余比例 0..1；窗口未知时为空 */
  remainingRatio?: number
  /** 本次是否要投递提醒 */
  remind: boolean
  /** 已跨过的阈值序号（1..len） */
  index: number
  /** 给模型看的提醒正文 */
  hint?: string
}

const IDLE: BudgetVerdict = { state: { delivered: 0 }, remind: false, index: 0 }

/**
 * 判断是否需要投递预算提醒。纯函数。
 *
 * @param usedInput 最近一次请求的输入 token（= 下一次请求的基数）
 * @param window    模型上下文窗口；未知（undefined / 0）时不做任何判断
 * @param prev      本 run 已投递的状态
 */
export function assessBudget(
  usedInput: number,
  window: number | undefined,
  prev?: BudgetState,
  thresholds: number[] = BUDGET_THRESHOLDS
): BudgetVerdict {
  const delivered = prev?.delivered ?? 0
  if (!window || !Number.isFinite(window) || window <= 0 || !Number.isFinite(usedInput) || usedInput <= 0) {
    return prev ? { ...IDLE, state: prev } : IDLE
  }

  const remainingRatio = Math.max(0, Math.min(1, (window - usedInput) / window))

  // 跨过了几个阈值（阈值从大到小排列，<= 即算跨过）
  const index = thresholds.filter((t) => remainingRatio <= t).length

  // 每个阈值只提醒一次：与 Codex 的 reminder_index 语义一致
  if (index <= delivered) return { state: { delivered }, remainingRatio, remind: false, index }

  return {
    state: { delivered: index },
    remainingRatio,
    remind: true,
    index,
    hint: budgetHint(remainingRatio, index, thresholds.length)
  }
}

function budgetHint(remainingRatio: number, index: number, total: number): string {
  const percent = Math.max(0, Math.round(remainingRatio * 100))
  const advice =
    index >= total
      ? '剩余空间已经很少，再展开新的探索很容易撞上上下文上限。优先收尾：把已完成的改动验证一遍，' +
        '把结论说清楚；确实还需要更多空间就告诉用户压缩上下文。'
      : '不必立刻停手，但要开始收着做：优先完成当前这条线索，避免再扩大范围；' +
        '需要更多空间时告诉用户可以压缩上下文（压缩会保留原分支，可随时切回）。'
  return `[上下文预算] 模型窗口已用约 ${100 - percent}%，剩余约 ${percent}%（第 ${index}/${total} 档提醒）。${advice}`
}
