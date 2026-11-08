import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { AgentTool, ToolResult } from './types'
import { asOptionalBool, asString, relPath, resolveInside, ToolError } from './util'
import { diffText } from '../diff'

const MAX_RESULT_CHARS = 6000

export const editTool: AgentTool = {
  spec: {
    name: 'edit',
    description:
      '在文件中做精确字符串替换：old_string 必须在文件中出现且默认只能出现一次。' +
      '多处相同内容需要全部替换时传 replace_all=true。old_string 建议带上足够上下文以保证唯一。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' },
        old_string: { type: 'string', description: '要被替换的原文（需与文件内容逐字符一致）' },
        new_string: { type: 'string', description: '替换后的新文本；传空字符串表示删除该段' },
        replace_all: { type: 'boolean', description: '是否替换所有匹配项，默认 false' }
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false
    }
  },

  async run(input, ctx): Promise<ToolResult> {
    const raw = asString(input, 'path', { required: true })
    const oldStr = asString(input, 'old_string')
    const newStr = asString(input, 'new_string', { fallback: '' })
    const replaceAll = asOptionalBool(input, 'replace_all') ?? false
    const abs = resolveInside(ctx.workspace, raw)
    const rel = relPath(ctx.workspace, abs)

    if (!oldStr) throw new ToolError('old_string 不能为空；如需整文件重写请用 write')
    if (oldStr === newStr) throw new ToolError('old_string 与 new_string 相同，无需修改')
    if (!existsSync(abs)) {
      return { content: `Error: 文件不存在：${rel}（新建文件请用 write）`, isError: true }
    }

    const before = readFileSync(abs, 'utf8')
    const occurrences: number[] = []
    let idx = before.indexOf(oldStr)
    while (idx !== -1 && occurrences.length < 50) {
      occurrences.push(idx)
      idx = before.indexOf(oldStr, idx + oldStr.length)
    }

    if (occurrences.length === 0) {
      return {
        content: `Error: 在 ${rel} 中找不到 old_string。请先用 read 查看当前内容，逐字符核对（注意缩进与换行）。`,
        isError: true
      }
    }
    if (occurrences.length > 1 && !replaceAll) {
      return {
        content: `Error: old_string 在 ${rel} 中匹配到 ${occurrences.length} 处。请提供更长、唯一的上下文，或传 replace_all=true。`,
        isError: true
      }
    }

    const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr)
    writeFileSync(abs, after, 'utf8')

    const diff = diffText(before, after, rel)
    const summary = `已修改 ${rel}（+${diff.additions} −${diff.removals}${replaceAll && occurrences.length > 1 ? `，共 ${occurrences.length} 处` : ''}）`
    const body = diff.text.length > MAX_RESULT_CHARS ? `${diff.text.slice(0, MAX_RESULT_CHARS)}\n… diff 已截断` : diff.text

    ctx.log('tool.edit', { path: abs, additions: diff.additions, removals: diff.removals })
    return {
      content: `${summary}\n\n${body}`,
      isError: false,
      meta: { kind: 'edit', path: rel, diff: diff.text, additions: diff.additions, removals: diff.removals }
    }
  }
}
