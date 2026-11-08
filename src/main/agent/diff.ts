export interface DiffResult {
  text: string
  additions: number
  removals: number
}

const MAX_LINES = 200

/**
 * 轻量行级 diff：裁掉公共前后缀，只呈现变化区间。
 * edit 工具的改动通常是局部的，这比完整 Myers 更省事也足够可读。
 */
export function diffText(oldText: string, newText: string, label = 'file', context = 3): DiffResult {
  if (oldText === newText) return { text: '(no changes)', additions: 0, removals: 0 }

  const a = oldText.split('\n')
  const b = newText.split('\n')

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++

  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++
  }

  const removed = a.slice(prefix, a.length - suffix)
  const added = b.slice(prefix, b.length - suffix)

  const start = Math.max(0, prefix - context)
  const tailOld = Math.min(a.length, a.length - suffix + context)
  const leadLines = a.slice(start, prefix)
  const trailLines = a.slice(a.length - suffix, tailOld)

  const out: string[] = [
    `--- a/${label}`,
    `+++ b/${label}`,
    `@@ -${start + 1},${leadLines.length + removed.length + trailLines.length} +${start + 1},${leadLines.length + added.length + trailLines.length} @@`
  ]
  for (const line of leadLines) out.push(` ${line}`)
  for (const line of removed) out.push(`-${line}`)
  for (const line of added) out.push(`+${line}`)
  for (const line of trailLines) out.push(` ${line}`)

  const clipped = out.length > MAX_LINES ? [...out.slice(0, MAX_LINES), `… diff truncated (${out.length - MAX_LINES} more lines)`] : out
  return { text: clipped.join('\n'), additions: added.length, removals: removed.length }
}
