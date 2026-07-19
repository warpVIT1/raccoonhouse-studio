import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'

export function PowerShareConsentPopup() {
  const request = useAppStore((s) => s.incomingPowerShareRequest)
  const clear = useAppStore((s) => s.clearIncomingPowerShareRequest)
  const { post } = useApi()
  const [secondsLeft, setSecondsLeft] = useState(0)

  useEffect(() => {
    if (!request) return
    setSecondsLeft(request.timeout_seconds)
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval)
          clear()
          return 0
        }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [request, clear])

  if (!request) return null

  async function respond(approved: boolean) {
    try {
      await post('/power-share/respond', { request_id: request!.request_id, approved })
    } catch {
      // ignore — the request will just time out on the asking side
    } finally {
      clear()
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-[100] w-80 rh-card p-4 shadow-2xl border border-rh-accent/40 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-rh-accent flex-shrink-0 animate-pulse" />
        <span className="text-xs font-semibold text-rh-accent">Запит потужності</span>
        <span className="ml-auto font-mono text-[11px] text-rh-muted">{secondsLeft}с</span>
      </div>
      <p className="text-xs text-rh-text-dim leading-relaxed">
        <span className="font-semibold text-rh-text">{request.requester_name}</span> хоче скористатися потужністю
        цього ПК для обробки «{request.title_name}», серія {String(request.episode_number).padStart(2, '0')}.
      </p>
      <div className="flex gap-2">
        <button onClick={() => respond(false)} className="rh-btn-ghost flex-1">Ні</button>
        <button onClick={() => respond(true)} className="rh-btn-primary flex-1">Так</button>
      </div>
    </div>
  )
}
