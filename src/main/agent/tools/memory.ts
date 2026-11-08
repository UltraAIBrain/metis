import type { AgentTool, ToolContext, ToolResult } from './types'
import { asString, ToolError } from './util'
import {
  GRAPH_MAX_EDGES,
  MAX_MEMORY_CHARS,
  MAX_USER_CHARS,
  loadGraph,
  loadHolo,
  nextEntryId,
  noteMemoryWrite,
  parseEntries,
  readMemory,
  readUser,
  saveGraph,
  saveHolo,
  scoreEntries,
  writeMemory,
  writeUser
} from '../memory-store'

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text
}

/**
 * memory：跨会话的持久记忆 + 记忆图谱 + 全息上下文 + 用户画像。
 *
 * 主存储是 ~/.pidesktop/MEMORY.md（人可读），图与全息元数据在旁边的 JSON 里；
 * scope=user 操作 ~/.pidesktop/USER.md（用户画像，全量注入每次请求）。
 * 领域逻辑（读写/解析/检索/nudge）在 ../memory-store，与 prompt 注入共用。
 * 并行子任务不提供本工具（并发写会交错），记忆由主 agent 维护。
 */
export const memoryTool: AgentTool = {
  spec: {
    name: 'memory',
    description:
      'Persistent memory across sessions, with a linkable knowledge graph, holographic context and a user profile. ' +
      'Use it to remember things worth carrying across conversations: the user\'s long-term ' +
      'preferences, durable project conventions, recurring pitfalls and their fixes. ' +
      'Do NOT store single-task details, file contents, or anything already written in AGENTS.md. ' +
      'Actions: append = add one entry (auto-id, context recorded); read = full memory; ' +
      'link = connect two entries with a relation; related = recall entries relevant to a query ' +
      '(tokenized scoring + graph expansion + provenance); rewrite = replace the whole memory to prune it. ' +
      'scope=user targets USER.md (who the user is, how they like to work) instead of project memory.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'append', 'rewrite', 'link', 'related'],
          description: 'read / append / link / related / rewrite — see description.'
        },
        content: {
          type: 'string',
          description: 'Entry text for append; full new content for rewrite; query text for related. Required for those actions.'
        },
        ids: {
          type: 'string',
          description: 'Two entry ids to connect, e.g. "m1 m3". Required for link.'
        },
        relation: { type: 'string', description: 'Short relation label for link, e.g. "causes" / "same-project" / "supersedes".' },
        scope: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'memory = project/world knowledge (default); user = USER.md profile of the user themselves. link/related only support scope=memory.'
        }
      },
      required: ['action'],
      additionalProperties: false
    }
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = asString(input, 'action', { required: true })
    const content = asString(input, 'content', { fallback: '' }).trim()
    const scope = asString(input, 'scope', { fallback: 'memory' }) === 'user' ? 'user' : 'memory'

    /* ---------------- 用户画像（USER.md）：read / append / rewrite ---------------- */
    if (scope === 'user') {
      if (action === 'read') {
        const current = readUser()
        ctx.log('tool.memory', { action, scope })
        return { content: current ? clip(current, MAX_USER_CHARS) : '（用户画像为空）', isError: false }
      }
      if (action === 'append') {
        if (!content) throw new ToolError('action=append 时 content 不能为空')
        const current = readUser()
        const flat = content.replace(/\s*\n\s*/g, ' ')
        const date = new Date().toISOString().slice(0, 10)
        if (current.length + flat.length + date.length + 6 > MAX_USER_CHARS) {
          throw new ToolError(`用户画像已接近上限（${MAX_USER_CHARS} 字符）。请先用 action=rewrite 精简。`)
        }
        writeUser(`${current}${current && !current.endsWith('\n') ? '\n' : ''}- [${date}] ${flat}\n`)
        noteMemoryWrite()
        ctx.log('tool.memory', { action, scope, chars: content.length })
        return { content: '已记入用户画像。', isError: false }
      }
      if (action === 'rewrite') {
        if (!content) throw new ToolError('action=rewrite 时 content 不能为空')
        if (content.length > MAX_USER_CHARS) {
          throw new ToolError(`用户画像超过 ${MAX_USER_CHARS} 字符上限，请精简后再写。`)
        }
        writeUser(`${content}\n`)
        noteMemoryWrite()
        ctx.log('tool.memory', { action, scope, chars: content.length })
        return { content: '用户画像已重写。', isError: false }
      }
      throw new ToolError('scope=user 只支持 read / append / rewrite。')
    }

    /* ---------------- 项目记忆（MEMORY.md） ---------------- */
    if (action === 'read') {
      const current = readMemory()
      ctx.log('tool.memory', { action })
      return { content: current ? clip(current, MAX_MEMORY_CHARS) : '（记忆为空）', isError: false }
    }

    if (action === 'related') {
      if (!content) throw new ToolError('action=related 需要 content（查询文本）')
      const entries = parseEntries(readMemory())
      if (!entries.length) return { content: '记忆为空或没有带 id 的条目，无法检索。', isError: false }
      const graph = loadGraph()
      const holo = loadHolo()
      const hits = scoreEntries(content, entries, graph).slice(0, 8)
      if (!hits.length) return { content: `没有与「${content}」相关的记忆。`, isError: false }
      const lines = hits.map(({ entry, score }) => {
        const h = holo[entry.id]
        const holoText = h ? ` · 来源: ${h.cwd || '?'}${h.session ? ` · 会话 ${h.session}` : ''} · ${h.at ? new Date(h.at).toLocaleDateString() : ''}` : ''
        const rels = graph.edges.filter((e) => e.a === entry.id || e.b === entry.id).map((e) => `${e.a}--${e.relation}-->${e.b}`)
        return `- (${entry.id}) [${entry.date}] ${entry.text}  {score ${score.toFixed(2)}${holoText}${rels.length ? ` · 关联: ${rels.join(', ')}` : ''}}`
      })
      return { content: `与「${content}」相关的记忆（相关度排序）：\n${lines.join('\n')}`, isError: false }
    }

    if (action === 'link') {
      const ids = asString(input, 'ids', { required: true }).trim().split(/\s+/)
      const relation = asString(input, 'relation', { fallback: 'related' }).trim().slice(0, 40) || 'related'
      if (ids.length !== 2 || !ids.every((id) => /^m\d+$/.test(id))) {
        throw new ToolError('link 需要 ids="mX mY"（两条已存在的记忆 id）')
      }
      const entries = parseEntries(readMemory())
      if (ids[0] === ids[1]) throw new ToolError('link 的两个 id 不能相同（不允许自环）')
      if (!entries.some((e) => e.id === ids[0]) || !entries.some((e) => e.id === ids[1])) {
        throw new ToolError(`记忆里没有 ${ids.filter((id) => !entries.some((e) => e.id === id)).join(' 或 ')}`)
      }
      const graph = loadGraph()
      if (graph.edges.length >= GRAPH_MAX_EDGES) {
        throw new ToolError(`图谱边数已达上限（${GRAPH_MAX_EDGES}）。请先精简记忆。`)
      }
      const dup = graph.edges.some(
        (e) => (e.a === ids[0] && e.b === ids[1]) || (e.a === ids[1] && e.b === ids[0])
      )
      if (!dup) {
        graph.edges.push({ a: ids[0], b: ids[1], relation, at: Date.now() })
        saveGraph(graph)
      }
      return { content: dup ? '这两条记忆已经关联过。' : `已关联 ${ids[0]} --${relation}--> ${ids[1]}。`, isError: false }
    }

    if (action === 'append') {
      if (!content) throw new ToolError('action=append 时 content 不能为空')
      const current = readMemory()
      const graph = loadGraph()
      const id = nextEntryId(graph)
      const date = new Date().toISOString().slice(0, 10)
      // 记忆条目是单行语义：压平换行，否则 parseEntries/related 检索会漏掉第二行
      const flat = content.replace(/\s*\n\s*/g, ' ')
      // 上限校验按写入后的真实长度估：current + 前缀"- (mN) [date] " + 条目 + 换行
      const projected = current.length + content.length + id.length + date.length + 16
      if (projected > MAX_MEMORY_CHARS) {
        throw new ToolError(
          `记忆已接近上限（${MAX_MEMORY_CHARS} 字符）。请先用 action=rewrite 精简旧条目，只保留仍然有效的部分。`
        )
      }
      // 写顺序：先推进图（消耗 id），再写条目本身。
      // 反过来若条目写成功而图写失败，下次 append 会分到相同 id，MEMORY.md 出现重复 id。
      saveGraph(graph)
      writeMemory(`${current}${current && !current.endsWith('\n') ? '\n' : ''}- (${id}) [${date}] ${flat}\n`)
      // 全息上下文：这条记忆产生时的会话与工作目录（缺失只是没有出处显示，无害）
      const holo = loadHolo()
      holo[id] = { session: ctx.sessionId, cwd: ctx.workspace, at: Date.now() }
      saveHolo(holo)
      noteMemoryWrite()
      ctx.log('tool.memory', { action, id, chars: content.length })
      return { content: `已记入 (${id})。后续可用 ids="${id} mY" 关联其他记忆。`, isError: false }
    }

    if (action === 'rewrite') {
      if (!content) throw new ToolError('action=rewrite 时 content 不能为空')
      if (content.length > MAX_MEMORY_CHARS) {
        throw new ToolError(`记忆内容超过 ${MAX_MEMORY_CHARS} 字符上限，请精简后再写。`)
      }
      writeMemory(`${content}\n`)
      // 清理失效 id 的元数据：rewrite 之后不在文件里的条目，其全息与边一并删除
      const kept = parseEntries(readMemory())
      const keep = new Set(kept.map((e) => e.id))
      const holo = loadHolo()
      for (const id of Object.keys(holo)) {
        if (!keep.has(id)) delete holo[id]
      }
      saveHolo(holo)
      const graph = loadGraph()
      graph.edges = graph.edges.filter((e) => keep.has(e.a) && keep.has(e.b))
      // 模型可能在 rewrite 内容里手写 id：nextId 必须超过文件里的最大 id，否则 append 会撞号
      const maxKept = kept.reduce((n, e) => Math.max(n, Number(e.id.slice(1)) || 0), 0)
      if (graph.nextId <= maxKept) graph.nextId = maxKept + 1
      saveGraph(graph)
      noteMemoryWrite()
      ctx.log('tool.memory', { action, chars: content.length })
      return { content: '记忆已重写。', isError: false }
    }

    throw new ToolError(`未知的 action：${action}`)
  }
}
