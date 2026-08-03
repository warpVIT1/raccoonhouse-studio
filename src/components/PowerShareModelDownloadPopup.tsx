import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { playRaccoonChirp } from '../utils/notificationSound'

// Second, narrower Так/Ні than PowerShareConsentPopup — asked only once a
// requester's job actually needs a checkpoint this PC doesn't have yet (see
// backend's ensure_model_for_peer_job). Skipped entirely when this PC has
// "Автоматично надавати доступ" on, same trust level as the main consent.
export function PowerShareModelDownloadPopup() {
  const request = useAppStore((s) => s.incomingModelDownloadRequest)
  const clear = useAppStore((s) => s.clearIncomingModelDownloadRequest)
  const { post } = useApi()
  const [secondsLeft, setSecondsLeft] = useState(0)

  useEffect(() => {
    if (request) playRaccoonChirp()
  }, [request?.request_id])

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
      await post('/power-share/respond-model-download', { request_id: request!.request_id, approved })
    } catch {
      // ignore — the request will just time out on the asking side
    } finally {
      clear()
    }
  }

  return (
    <div className="fixed bottom-6 right-6 z-[100] w-80 rh-card p-4 shadow-2xl border border-amber-400/40 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-amber-400 flex-shrink-0 animate-pulse" />
        <span className="text-xs font-semibold text-amber-400">Потрібна модель</span>
        <span className="ml-auto font-mono text-[11px] text-rh-muted">{secondsLeft}с</span>
      </div>
      <p className="text-xs text-rh-text-dim leading-relaxed">
        <span className="font-semibold text-rh-text">{request.requester_name}</span> хоче обробити
        «{request.title_name}», серія {String(request.episode_number).padStart(2, '0')} моделлю, якої немає
        на цьому ПК — <span className="font-mono text-[11px] text-rh-text">{request.filename}</span>.
        Завантажити її зараз?
      </p>
      <div className="flex gap-2">
        <button onClick={() => respond(false)} className="rh-btn-ghost flex-1">Ні</button>
        <button onClick={() => respond(true)} className="rh-btn-primary flex-1">Так, завантажити</button>
      </div>
    </div>
  )
}
