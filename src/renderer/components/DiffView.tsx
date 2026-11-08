const MAX_LINES = 1200

export function DiffView({ diff }: { diff: string }): JSX.Element {
  const allLines = diff.split('\n')
  const lines = allLines.slice(0, MAX_LINES)
  return (
    <pre className="diff">
      {lines.map((line, i) => {
        let cls = 'diff-line'
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' diff-meta'
        else if (line.startsWith('@@')) cls += ' diff-hunk'
        else if (line.startsWith('+')) cls += ' diff-add'
        else if (line.startsWith('-')) cls += ' diff-del'
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
      {allLines.length > MAX_LINES && <div className="diff-line diff-meta">… 差异过长，已省略后续 {allLines.length - MAX_LINES} 行</div>}
    </pre>
  )
}
