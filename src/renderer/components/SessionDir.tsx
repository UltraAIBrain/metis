import { memo } from 'react'
import { store, useSlice } from '../store'
import { baseName, hasStarted } from '../util'

/**
 * 会话（项目）目录，放在会话窗口的顶栏。
 * 会话一旦开始就不能再改目录——历史消息里的相对路径会失效。
 */
export const SessionDir = memo(function SessionDir(): JSX.Element {
  const session = useSlice((s) => s.session)
  if (!session) return <></>

  const locked = hasStarted(session)
  const cwd = session.cwd
  const label = cwd ? baseName(cwd) : '选择目录'

  const icon = (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 4.5h4l1.2 1.5H14v7H2z" strokeLinejoin="round" />
    </svg>
  )

  if (locked) {
    return (
      <span className="dir-chip locked" title={`${cwd || '自动目录'} · 会话已开始，目录已锁定`}>
        {icon}
        <span className="dir-name">{label}</span>
        <svg className="dir-lock" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="4" y="7" width="8" height="6" rx="1.4" />
          <path d="M6 7V5.5a2 2 0 014 0V7" strokeLinecap="round" />
        </svg>
      </span>
    )
  }

  return (
    <button
      className={`dir-chip ${cwd ? '' : 'empty'}`}
      type="button"
      title={cwd ? `${cwd} · 点击更换目录` : '还没指定目录：不选也行，首次发送时会自动创建'}
      onClick={() => void store.changeCwd()}
    >
      {icon}
      <span className="dir-name">{label}</span>
    </button>
  )
})
