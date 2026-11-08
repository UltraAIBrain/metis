import { memo } from 'react'
import type { Notice } from '../store'
import { store } from '../store'

export const Toasts = memo(function Toasts({ notices }: { notices: Notice[] }): JSX.Element {
  return (
    <div className="toasts">
      {notices.map((n) => (
        <div key={n.id} className={`toast ${n.level}`} onClick={() => store.dismiss(n.id)}>
          <span className="toast-dot" />
          <span className="toast-text">{n.text}</span>
        </div>
      ))}
    </div>
  )
})
