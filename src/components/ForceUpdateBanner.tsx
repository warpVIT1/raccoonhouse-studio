import React from 'react'
import { useAppStore } from '../stores/appStore'

// Not an actual forced download/install (forcibly restarting someone's app
// mid-render would destroy active work) — a dismissible nudge pushed by an
// admin to every online peer (see backend's broadcast_force_update_request),
// asking them to go check for an update themselves.
export function ForceUpdateBanner() {
  const notice = useAppStore((s) => s.forceUpdateNotice)
  const clear = useAppStore((s) => s.clearForceUpdateNotice)
  if (!notice) return null

  function checkNow() {
    window.electronAPI?.checkForUpdate()
    clear()
  }

  return (
    <div className="fixed bottom-6 left-6 z-[100] w-80 rh-card p-4 shadow-2xl border border-amber-400/40 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0 animate-pulse" />
        <span className="text-xs font-semibold text-amber-400">Прохання оновитись</span>
      </div>
      <p className="text-xs text-rh-text-dim leading-relaxed">
        <span className="font-semibold text-rh-text">{notice.from_name}</span> просить усіх перевірити та встановити оновлення.
      </p>
      <div className="flex gap-2">
        <button onClick={clear} className="rh-btn-ghost flex-1">Пізніше</button>
        <button onClick={checkNow} className="rh-btn-primary flex-1">Перевірити зараз</button>
      </div>
    </div>
  )
}
