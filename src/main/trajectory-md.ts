import type { Trajectory } from '@shared/types'

/**
 * 轨迹 → 人类可读的 Markdown 报告。
 * 结构仿 harness 的 trajectory dump：回合分段，每步带工具与观察。
 */

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 工具参数里最值得看的一列：bash 给命令，文件类给路径 */
function inputSummary(input?: Record<string, unknown>): string {
  if (!input) return ''
  if (typeof input.command === 'string') return String(input.command)
  if (typeof input.path === 'string') return String(input.path)
  return JSON.stringify(input).slice(0, 120)
}

function clip(text: string, max = 1600): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（截断，全文见 JSON 导出）`
}

/** 内容里出现 ``` 时用更长的围栏，避免破坏 Markdown 结构 */
function fenced(text: string): string {
  const fence = text.includes('```') ? '````' : '```'
  return `${fence}\n${clip(text)}\n${fence}`
}

export function trajectoryToMarkdown(t: Trajectory): string {
  const lines: string[] = []
  const title = t.title || '未命名会话'

  lines.push(`# 运行轨迹：${title}`)
  lines.push('')
  lines.push(`- 会话：\`${t.sessionId}\``)
  if (t.cwd) lines.push(`- 工作目录：\`${t.cwd}\``)
  if (t.model) lines.push(`- 模型：\`${t.model}\``)
  lines.push(`- 导出时间：${new Date(t.exportedAt).toLocaleString()}`)
  lines.push(
    `- 汇总：${t.totals.turns} 个回合 · ${t.totals.steps} 步 · ` +
      `输入 ${fmtTokens(t.totals.inputTokens)} / 输出 ${fmtTokens(t.totals.outputTokens)} tokens · ` +
      `跨度 ${fmtDuration(t.totals.durationMs)}`
  )
  lines.push('')

  t.turns.forEach((turn, ti) => {
    lines.push(`## 回合 ${ti + 1}`)
    lines.push('')
    lines.push(`> ${turn.userText.replace(/\n/g, '\n> ') || '（附件）'}`)
    lines.push('')

    turn.responses.forEach((r, ri) => {
      const head =
        ri === 0
          ? `**模型 · ${r.model}**`
          : `**步 ${ri + 1} · ${r.model}**`
      const usage = r.usage ? ` · in ${fmtTokens(r.usage.input)} / out ${fmtTokens(r.usage.output)}` : ''
      lines.push(`### ${head}${usage}`)
      lines.push('')

      if (r.error) {
        lines.push(`> ⚠️ 本步出错：${r.error.split('\n')[0]}`)
        lines.push('')
      }
      if (r.text) {
        lines.push(r.text)
        lines.push('')
      }
      for (const call of r.toolCalls) {
        const mark = call.isError ? '✗' : '✓'
        const summary = inputSummary(call.input)
        const dur = call.durationMs !== undefined ? ` · ${fmtDuration(call.durationMs)}` : ''
        lines.push(`**${mark} ${call.name}**${summary ? ` \`${summary}\`` : ''}${dur}`)
        lines.push('')
        lines.push(fenced(call.content))
        lines.push('')
      }
    })
  })

  // 子任务过程回放：与 JSON 导出的 subProcesses 对应
  if (t.subProcesses && Object.keys(t.subProcesses).length) {
    lines.push('## 子任务过程')
    lines.push('')
    for (const run of Object.values(t.subProcesses)) {
      lines.push(
        `### ${run.label}（${run.type} · ${run.steps} 步 · in ${fmtTokens(run.usage.input)} / out ${fmtTokens(run.usage.output)} · ${run.isError ? '失败' : '完成'}）`
      )
      lines.push('')
      if (run.result) {
        lines.push(fenced(run.result))
        lines.push('')
      }
      for (const m of run.messages) {
        if (m.role === 'tool') {
          lines.push(`**↳ ${m.name}**${m.isError ? '（失败）' : ''}`)
          lines.push('')
          lines.push(fenced(m.content))
          lines.push('')
        }
      }
    }
  }

  lines.push('---')
  lines.push('')
  lines.push('*由 Pi Desktop 导出；机器可读版本请导出 JSON。*')
  return lines.join('\n')
}
