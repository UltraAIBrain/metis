import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentTool, ToolResult } from './types'
import { asString, formatBytes, relPath, resolveInside } from './util'

export const writeTool: AgentTool = {
  spec: {
    name: 'write',
    description:
      '将内容整体写入文件（覆盖已有内容；父目录不存在会自动创建）。' +
      '修改已有文件的局部内容请优先使用 edit，write 适合新建文件或整文件重写。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' },
        content: { type: 'string', description: '要写入的完整文件内容' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },

  async run(input, ctx): Promise<ToolResult> {
    const raw = asString(input, 'path', { required: true })
    const content = asString(input, 'content', { fallback: '' })
    const abs = resolveInside(ctx.workspace, raw)

    const existed = existsSync(abs)
    mkdirSync(dirname(abs), { recursive: true })
    const bytes = Buffer.byteLength(content, 'utf8')
    writeFileSync(abs, content, 'utf8')

    const rel = relPath(ctx.workspace, abs)
    ctx.log('tool.write', { path: abs, bytes, existed })
    return {
      content: existed
        ? `已覆盖写入 ${rel}（${formatBytes(bytes)}）。注意：该文件原有内容已被替换。`
        : `已创建 ${rel}（${formatBytes(bytes)}）。`,
      isError: false,
      meta: { kind: 'write', path: rel, bytes, created: !existed }
    }
  }
}
