import React, { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { useApi } from '../hooks/useApi'

// Not an actual forced download/install (forcibly restarting someone's app
// mid-render would destroy active work) — a dismissible nudge from an admin
// asking everyone to go check for an update themselves.
//
// Reaches people two ways, both carrying the same notice id: a live push to
// whoever is online (appStore's force_update_request handler), and a notice
// saved on the Worker that this component polls — so someone who was offline
// when it was sent still sees it once at their next launch. Each id is shown
// at most once per install (SEEN_UPDATE_NOTICE_KEY), until the admin sends a
// new one.
export const SEEN_UPDATE_NOTICE_KEY = 'rh_seen_update_notice'
const NOTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // a stale week-old notice isn't news to a fresh install
const POLL_INTERVAL_MS = 10 * 60 * 1000

// Lets UpdateDialog re-open for a version the person already dismissed.
export const UPDATE_RECHECK_EVENT = 'rh:update-recheck'

export function ForceUpdateBanner() {
  const notice = useAppStore((s) => s.forceUpdateNotice)
  const clear = useAppStore((s) => s.clearForceUpdateNotice)
  const { get } = useApi()

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const n = await get<{ id: string; from_name: string; created_at?: string } | null>('/power-share/update-notice')
        if (cancelled || !n?.id) return
        if (localStorage.getItem(SEEN_UPDATE_NOTICE_KEY) === n.id) return
        if (n.created_at && Date.now() - new Date(n.created_at).getTime() > NOTICE_MAX_AGE_MS) return
        useAppStore.setState({ forceUpdateNotice: { from_name: n.from_name, id: n.id } })
      } catch {
        // backend still starting or Worker unreachable — the next poll retries
      }
    }
    // The backend may not be up yet at first paint, so retry early too.
    const early = [setTimeout(poll, 4000), setTimeout(poll, 30000)]
    const timer = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      early.forEach(clearTimeout)
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Whichever channel delivered it: remember the id so it never shows twice,
  // and start looking for the release right away rather than waiting for the
  // next scheduled check.
  useEffect(() => {
    if (!notice) return
    if (notice.id) localStorage.setItem(SEEN_UPDATE_NOTICE_KEY, notice.id)
    window.dispatchEvent(new Event(UPDATE_RECHECK_EVENT))
    window.electronAPI?.checkForUpdate()
  }, [notice])

  if (!notice) return null

  function checkNow() {
    window.dispatchEvent(new Event(UPDATE_RECHECK_EVENT))
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
