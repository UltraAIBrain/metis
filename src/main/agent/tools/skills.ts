import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { paths } from '../../paths'
import type { AgentTool, ToolContext, ToolResult } from './types'
import { asString, ToolError } from './util'

/**
 * 技能（procedural memory）：模型从经验里自己沉淀的可复用过程，
 * 存 ~/.pidesktop/skills/<id>/SKILL.md（agentskills.io 风格的 frontmatter + 正文）。
 * system prompt 只注入一行索引（id — description），正文按需 read —— 技能多了也不烧 token。
 * 使用中发现技能有问题就 rewrite 改进它，这就是"技能在使用中自我改进"。
 */

const MAX_SKILLS = 100
const MAX_BODY_CHARS = 12_000
const MAX_DESC_CHARS = 160
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/

interface Skill {
  id: string
  description: string
  body: string
  mtime: number
}

function skillDir(id: string): string {
  return `${paths.skills()}/${id}`
}
function skillFile(id: string): string {
  return `${skillDir(id)}/SKILL.md`
}

function parseSkill(id: string, raw: string, mtime: number): Skill {
  // frontmatter：---\nname: ...\ndescription: ...\n---，description 支持整行取值
  let description = ''
  let body = raw
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (m) {
    body = m[2]
    const dm = m[1].match(/^description:\s*(.+)$/m)
    if (dm) description = dm[1].trim().slice(0, MAX_DESC_CHARS)
  }
  return { id, description, body: body.trim(), mtime }
}

export function loadSkills(): Skill[] {
  const root = paths.skills()
  if (!existsSync(root)) return []
  const out: Skill[] = []
  for (const name of readdirSync(root)) {
    if (!ID_RE.test(name)) continue
    const file = skillFile(name)
    if (!existsSync(file)) continue
    try {
      const st = statSync(file)
      out.push(parseSkill(name, readFileSync(file, 'utf8'), st.mtimeMs))
    } catch {
      /* 单个技能损坏不影响其余 */
    }
    if (out.length >= MAX_SKILLS) break
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** system prompt 里的技能索引（一行一个；数量多了也只烧几百 token） */
export function skillsIndexLines(): string[] {
  return loadSkills().map((s) => `- ${s.id}${s.description ? ` — ${s.description}` : ''}`)
}

export const skillsTool: AgentTool = {
  spec: {
    name: 'skills',
    description:
      'Procedural memory: reusable playbooks YOU write and improve over time. ' +
      'Each skill is a markdown file (id + one-line description + step-by-step body). ' +
      'Read a skill before following it; after finishing a task that revealed a repeatable procedure ' +
      '(setup steps, release checklist, debugging recipe), write it as a new skill or improve the existing one. ' +
      'Actions: list = index with descriptions; read = full body of one skill; ' +
      'write = create or replace a skill (id + description + body).',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'write'],
          description: 'list / read / write'
        },
        id: { type: 'string', description: 'Skill id (lowercase letters/digits/hyphens), e.g. "release-checklist". Required for read/write.' },
        description: { type: 'string', description: 'One-line description for write (what situation this skill covers).' },
        content: { type: 'string', description: 'Full markdown body for write (steps, commands, pitfalls). No frontmatter needed.' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = asString(input, 'action', { required: true })
    const id = asString(input, 'id', { fallback: '' }).trim()

    if (action === 'list') {
      const skills = loadSkills()
      if (!skills.length) return { content: '还没有技能。完成可复用的任务后用 write 沉淀一个。', isError: false }
      const lines = skills.map(
        (s) => `- ${s.id}${s.description ? ` — ${s.description}` : ''} · 更新于 ${new Date(s.mtime).toLocaleDateString()}`
      )
      return { content: `技能清单（read 取全文）：\n${lines.join('\n')}`, isError: false }
    }

    if (action === 'read') {
      if (!id) throw new ToolError('action=read 需要 id')
      if (!ID_RE.test(id)) throw new ToolError('技能 id 只能是小写字母/数字/连字符（2–40 字符）')
      const file = skillFile(id)
      if (!existsSync(file)) throw new ToolError(`没有这个技能：${id}（先 list 查看）`)
      const s = parseSkill(id, readFileSync(file, 'utf8'), Date.now())
      return { content: `# ${s.id}\n${s.description}\n\n${s.body}`.slice(0, MAX_BODY_CHARS), isError: false }
    }

    if (action === 'write') {
      if (!id) throw new ToolError('action=write 需要 id')
      if (!ID_RE.test(id)) throw new ToolError('技能 id 只能是小写字母/数字/连字符（2–40 字符）')
      const description = asString(input, 'description', { fallback: '' }).trim().slice(0, MAX_DESC_CHARS)
      const body = asString(input, 'content', { required: true }).trim()
      if (!description) throw new ToolError('write 需要 description（一句话说明适用场景）')
      if (body.length > MAX_BODY_CHARS) throw new ToolError(`技能正文超过 ${MAX_BODY_CHARS} 字符上限，请精简。`)
      if (!existsSync(paths.skills())) mkdirSync(paths.skills(), { recursive: true })
      if (!existsSync(skillDir(id))) mkdirSync(skillDir(id), { recursive: true })
      const existed = existsSync(skillFile(id))
      // 原子写：tmp + rename
      const tmp = `${skillFile(id)}.tmp`
      writeFileSync(tmp, `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8')
      renameSync(tmp, skillFile(id))
      ctx.log('tool.skills', { action: existed ? 'update' : 'create', id })
      return { content: existed ? `技能 ${id} 已更新。` : `技能 ${id} 已创建。`, isError: false }
    }

    throw new ToolError(`未知的 action：${action}`)
  }
}
