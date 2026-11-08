import { memo, useEffect, useRef, useState } from 'react'
import type { DirEntry, SessionView } from '@shared/types'
import { store } from '../../store'
import { baseName } from '../../util'
import { RowIcon } from '../../file-icons'
import { DiffView } from '../DiffView'

/**
 * 面板内嵌工作空间：目录树懒加载（每层一个 IPC），点文件看对 HEAD 的 diff，
 * 也可以用系统程序打开。树状态在组件内；会话切换时重置回根目录。
 */

type Entries = DirEntry[] | 'loading' | 'error'

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const joinRel = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)

export const FilesPane = memo(function FilesPane({ session }: { session: SessionView }): JSX.Element {
  const sessionId = session.id
  const [dirs, setDirs] = useState<Record<string, Entries>>({ '': 'loading' })
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ text: string; loading: boolean }>({ text: '', loading: false })
  const reqRef = useRef(0)
  const diffRequest = useRef(0)
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId

  useEffect(() => {
    const id = ++reqRef.current
    diffRequest.current++
    setDirs({ '': 'loading' })
    setExpanded(new Set(['']))
    setSelected(null)
    setDiff({ text: '', loading: false })
    let cancelled = false
    store
      .fetchDir(sessionId, '')
      .then((list) => {
        if (cancelled || reqRef.current !== id || sessionRef.current !== sessionId) return
        setDirs({ '': list })
      })
      .catch((err) => {
        if (cancelled || reqRef.current !== id || sessionRef.current !== sessionId) return
        setDirs({ '': 'error' })
        store.notify('error', `读取目录失败：${(err as Error).message}`)
      })
    return () => {
      cancelled = true
      reqRef.current++
      diffRequest.current++
    }
  }, [sessionId])

  const toggleDir = (rel: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(rel)) next.delete(rel)
      else next.add(rel)
      return next
    })
    if (dirs[rel]) return
    const request = reqRef.current
    setDirs((d) => ({ ...d, [rel]: 'loading' }))
    store
      .fetchDir(sessionId, rel)
      .then((list) => {
        if (request !== reqRef.current || sessionRef.current !== sessionId) return
        setDirs((d) => ({ ...d, [rel]: list }))
      })
      .catch((err) => {
        if (request !== reqRef.current || sessionRef.current !== sessionId) return
        setDirs((d) => ({ ...d, [rel]: 'error' }))
        store.notify('error', `读取目录失败：${(err as Error).message}`)
      })
  }

  const selectFile = async (rel: string): Promise<void> => {
    const request = ++diffRequest.current
    if (selected === rel) {
      setSelected(null)
      setDiff({ text: '', loading: false })
      return
    }
    setSelected(rel)
    setDiff({ text: '', loading: true })
    try {
      const text = await store.fetchDiff(sessionId, rel)
      if (request !== diffRequest.current || sessionRef.current !== sessionId) return
      setDiff({ text, loading: false })
    } catch {
      if (request !== diffRequest.current || sessionRef.current !== sessionId) return
      setDiff({ text: '', loading: false })
      store.notify('error', '读取差异失败')
    }
  }

  const renderRows = (dirRel: string, depth: number): JSX.Element[] => {
    const entries = dirs[dirRel]
    if (entries === 'loading') {
      return [
        <div key={`${dirRel}#loading`} className="panel-empty" style={{ paddingLeft: 18 + depth * 14 }}>
          读取中…
        </div>
      ]
    }
    if (entries === 'error') {
      return [
        <div key={`${dirRel}#error`} className="panel-empty" style={{ paddingLeft: 18 + depth * 14 }}>
          读取失败
        </div>
      ]
    }
    if (!entries?.length) {
      return [
        <div key={`${dirRel}#empty`} className="panel-empty" style={{ paddingLeft: 18 + depth * 14 }}>
          空目录
        </div>
      ]
    }
    return entries.map((e) => {
      const rel = joinRel(dirRel, e.name)
      if (e.kind === 'dir') {
        const open = expanded.has(rel)
        return (
          <div key={rel}>
            <button className="tree-row" type="button" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => toggleDir(rel)}>
              <span className={`chev ${open ? 'open' : ''}`}>▸</span>
              <RowIcon name={e.name} isDir open={open} />
              <span className="tree-name">{e.name}</span>
            </button>
            {open && renderRows(rel, depth + 1)}
          </div>
        )
      }
      return (
        <button
          key={rel}
          className={`tree-row ${selected === rel ? 'tree-selected' : ''}`}
          type="button"
          title={rel}
          style={{ paddingLeft: 10 + depth * 14 + 14 }}
          onClick={() => void selectFile(rel)}
        >
          <RowIcon name={e.name} isDir={false} />
          <span className="tree-name">{e.name}</span>
          <span className="tree-size">{formatSize(e.size)}</span>
        </button>
      )
    })
  }

  return (
    <div className="panel-pane">
      <div className="pane-tree">
        <div className="tree-root" title={session.cwd}>
          {baseName(session.cwd) || session.cwd}
        </div>
        {renderRows('', 0)}
      </div>

      {selected && (
        <div className="pane-file">
          <div className="pane-file-head">
            <span className="panel-file-name" title={selected}>
              {selected}
            </span>
            <button className="pane-btn" type="button" onClick={() => void store.openWorkspaceFile(sessionId, selected)}>
              系统打开
            </button>
            <button className="pane-btn" type="button" onClick={() => void selectFile(selected)}>
              收起
            </button>
          </div>
          <div className="panel-diff">
            {diff.loading ? (
              <div className="panel-empty">读取差异…</div>
            ) : diff.text ? (
              <DiffView diff={diff.text} />
            ) : (
              <div className="panel-empty">对 HEAD 无差异（可能是未跟踪的新文件）</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
