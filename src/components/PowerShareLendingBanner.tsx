import React from 'react'
import { useAppStore } from '../stores/appStore'

export function PowerShareLendingBanner() {
  const status = useAppStore((s) => s.lendingStatus)
  if (!status) return null

  const taskLabel = status.task === 'import' ? 'ffmpeg (імпорт відео)' : status.task === 'render' ? 'ffmpeg (фінальний рендер)' : 'нейромережа (відокремлення вокалу)'
  const hasPercent = typeof status.percent === 'number'

  return (
    <div className="fixed top-11 left-1/2 -translate-x-1/2 z-[90] rh-card px-4 py-2 shadow-2xl border border-emerald-500/40 flex items-center gap-2.5">
      <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0 animate-pulse" />
      <span className="text-xs text-rh-text-dim">
        Ви допомагаєте <span className="font-semibold text-rh-text">{status.requester_name}</span>:
        {' '}{taskLabel} — «{status.title_name}», серія {String(status.episode_number).padStart(2, '0')}
        {hasPercent && <span className="font-semibold text-emerald-400"> — {status.percent}%</span>}
      </span>
      {hasPercent && (
        <div className="h-1 w-16 flex-shrink-0 rounded-full bg-rh-border overflow-hidden">
          <div className="h-full bg-emerald-400 transition-all" style={{ width: `${status.percent}%` }} />
        </div>
      )}
    </div>
  )
}
