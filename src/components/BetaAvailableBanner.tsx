import React, { useEffect, useState } from 'react'

interface BetaInfo {
  version: string
  url: string
  notes?: string
}

const DISMISSED_KEY = 'rh_beta_banner_dismissed_version'

// Small, dismissible, opt-in-only notice that a beta exists — deliberately
// separate from UpdateDialog (which drives the main auto-update flow): a
// stable install never auto-downloads or auto-installs a beta on its own,
// this only ever opens the GitHub release page for a manual look. See
// electron/main.ts's checkForBetaAvailable for why this needs its own check
// instead of just reusing electron-updater's result.
export function BetaAvailableBanner() {
  const [info, setInfo] = useState<BetaInfo | null>(null)

  useEffect(() => {
    if (!window.electronAPI?.onBetaAvailable) return
    return window.electronAPI.onBetaAvailable((raw) => {
      const next = raw as unknown as BetaInfo
      if (localStorage.getItem(DISMISSED_KEY) === next.version) return
      setInfo(next)
    })
  }, [])

  if (!info) return null

  function dismiss() {
    if (info) localStorage.setItem(DISMISSED_KEY, info.version)
    setInfo(null)
  }

  return (
    <div className="fixed bottom-6 left-6 z-[90] w-72 rh-card p-3 shadow-2xl border border-rh-border flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs">🧪</span>
        <span className="text-xs font-semibold text-rh-text">Доступна бета {info.version}</span>
        <button onClick={dismiss} className="ml-auto text-rh-muted hover:text-white text-sm leading-none px-1">✕</button>
      </div>
      <p className="text-[11px] text-rh-muted leading-relaxed">
        Нові функції на випробуванні, ще не в стабільному релізі. Встановлення — вручну, на власний розсуд.
      </p>
      <button
        onClick={() => window.electronAPI?.openExternal(info.url)}
        className="rh-btn-outline text-[11px] self-start px-2.5 py-1"
      >
        Детальніше на GitHub
      </button>
    </div>
  )
}
