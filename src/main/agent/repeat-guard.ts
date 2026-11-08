/**
 * 重复调用检测。
 *
 * 「同样的工具 + 完全相同的参数」连续出现，是**真实的异常信号**（空转 / 死循环），
 * 而不是「步数」那种与任务难度不相干的代理指标。所以这里只盯这一件事：
 * 连续相同 → 提醒模型换思路。
 *
 * 明确的边界：**只提示，不中止**。循环的终止权始终在模型手里
 * （它不再调用工具就结束）或用户手里（Esc）。这里不引入任何次数上限。
 */

/** 连续相同调用的计数状态；中间插了别的调用就重置 */
export interface RepeatState {
  /** 上一次调用的指纹：工具名 + 规范化参数 */
  key: string
  /** 连续相同的次数（1 = 首次出现） */
  count: number
}

export interface RepeatVerdict {
  /** 更新后的状态，调用方负责存回去 */
  state: RepeatState
  /** 本次是连续第几次相同调用 */
  count: number
  /** 本次是否需要提醒（第 3、6、9… 次；不要每次都弹，否则提醒本身变成噪音） */
  remind: boolean
}

/** 连续多久开始提醒；之后每 N 次再提醒一次 */
export const REPEAT_REMIND_EVERY = 3

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

/**
 * 参数的规范化序列化。只用于比较，不用于展示。
 * 模型给同一组参数时键序可能不同（有时还带个空字符串默认值），排序后比较才不会漏判。
 */
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
 * 记录一次调用并给出裁决。纯函数：同样的输入永远得到同样的输出，方便单测。
 */
export function noteCall(prev: RepeatState | undefined, name: string, input: unknown): RepeatVerdict {
  const key = callKey(name, input)
  const count = prev && prev.key === key ? prev.count + 1 : 1
  return {
    state: { key, count },
    count,
    remind: count >= REPEAT_REMIND_EVERY && count % REPEAT_REMIND_EVERY === 0
  }
}
