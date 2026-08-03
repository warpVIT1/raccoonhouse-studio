import React from 'react'
import { useAppStore } from '../stores/appStore'

// Mirrors PowerShareLendingBanner, shown on the REQUESTER's own machine —
// live progress relayed back from whichever peer is actually doing the work
// (see backend's _relay_progress / discovery_service._handle_job_progress),
// so asking for power doesn't mean staring at a blind spinner while someone
// else's PC visibly shows the same percent.
export function PowerShareBorrowingBanner() {
  const status = useAppStore((s) => s.borrowingStatus)
  if (!status || !status.peer_name) return null

  const taskLabel = status.task === 'import' ? 'ffmpeg (імпорт відео)' : status.task === 'render' ? 'ffmpeg (фінальний рендер)' : 'нейромережа (відокремлення вокалу)'
  const hasPercent = typeof status.percent === 'number'

  return (
    <div className="fixed top-11 left-1/2 -translate-x-1/2 z-[90] rh-card px-4 py-2 shadow-2xl border border-rh-accent/40 flex items-center gap-2.5">
      <span className="w-2 h-2 rounded-full bg-rh-accent flex-shrink-0 animate-pulse" />
      <span className="text-xs text-rh-text-dim">
        Вам допомагає <span className="font-semibold text-rh-text">{status.peer_name}</span>:
        {' '}{taskLabel}{status.title_name && <> — «{status.title_name}», серія {String(status.episode_number).padStart(2, '0')}</>}
        {hasPercent && <span className="font-semibold text-rh-accent"> — {status.percent}%</span>}
      </span>
      {hasPercent && (
        <div className="h-1 w-16 flex-shrink-0 rounded-full bg-rh-border overflow-hidden">
          <div className="h-full bg-rh-accent transition-all" style={{ width: `${status.percent}%` }} />
        </div>
      )}
    </div>
  )
}
