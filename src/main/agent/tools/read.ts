import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AgentTool, ToolResult } from './types'
import { asOptionalNumber, asString, relPath, resolveInside } from './util'

const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 5000

export const readTool: AgentTool = {
  spec: {
    name: 'read',
    description:
      '读取工作目录内文件的内容，返回带行号的文本。' +
      '大文件用 offset/limit 分段读取（offset 从 1 开始的行号，limit 为行数，默认 2000 行，最大 5000 行）。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' },
        offset: { type: 'number', description: '起始行号（1 基），可选' },
        limit: { type: 'number', description: '读取行数，可选，默认 2000，最大 5000' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },

  async run(input, ctx): Promise<ToolResult> {
    const raw = asString(input, 'path', { required: true })
    const abs = resolveInside(ctx.workspace, raw)

    let stat
    try {
      stat = statSync(abs)
    } catch {
      return { content: `Error: 文件不存在：${raw}`, isError: true }
    }
    if (stat.isDirectory()) {
      return { content: `Error: ${raw} 是目录，请用 bash 列出目录内容（例如 ls 或 dir）`, isError: true }
    }

    const fd = openSync(abs, 'r')
    const head = Buffer.alloc(8192)
    let headBytes = 0
    try {
      headBytes = readSync(fd, head, 0, head.length, 0)
    } finally {
      closeSync(fd)
    }
    if (head.subarray(0, headBytes).includes(0)) {
      return { content: `Error: ${raw} 看起来是二进制文件，无法按文本读取`, isError: true }
    }

    const offset = Math.max(1, Math.floor(asOptionalNumber(input, 'offset') ?? 1))
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(asOptionalNumber(input, 'limit') ?? DEFAULT_LIMIT)))
    const slice: string[] = []
    let totalLines = 0
    const lines = createInterface({ input: createReadStream(abs, { encoding: 'utf8' }), crlfDelay: Infinity })
    for await (const line of lines) {
      totalLines++
      if (totalLines >= offset && slice.length < limit) slice.push(line)
    }

    const start = offset - 1
    if (start >= totalLines) {
      return { content: `Error: offset ${offset} 超出文件行数（共 ${totalLines} 行）`, isError: true }
    }
    const endLine = start + slice.length
    const truncated = endLine < totalLines

    const body = slice.map((line, i) => `${String(start + i + 1).padStart(5, ' ')}| ${line}`).join('\n')
    const footer = truncated
      ? `\n\n… 已截断：显示第 ${offset}-${endLine} 行，共 ${totalLines} 行。需要后续内容请传 offset=${endLine + 1}。`
      : ''

    ctx.log('tool.read', { path: abs, lines: slice.length, total: totalLines })
    return {
      content: body + footer,
      isError: false,
      meta: {
        kind: 'read',
        path: relPath(ctx.workspace, abs),
        startLine: offset,
        endLine,
        totalLines,
        truncated
      }
    }
  }
}
