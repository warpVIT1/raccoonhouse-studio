import React, { useEffect, useRef, useState } from 'react'
import { Spinner } from './ui/Spinner'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { MiniMarkdown } from '../utils/miniMarkdown'
import { UPDATE_RECHECK_EVENT } from './ForceUpdateBanner'

interface UpdateState {
  status: string
  version?: string
  percent?: number
  message?: string
  releaseNotes?: string
}

// Shown automatically the moment a check (on launch, then every 10 min and
// whenever the window regains focus) finds a newer version — separate from UpdatePanel in Settings (which is for a
// manual, on-demand check). Clicking "Оновити" is the only click needed —
// it downloads and then installs itself the moment the download finishes,
// no second "are you sure, install now?" prompt.
export function UpdateDialog() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)
  const [autoInstall, setAutoInstall] = useState(false)
  // Version the person already clicked "Пізніше" on. Checks now repeat every
  // few minutes, and each one re-announces 'available' — without this the
  // dialog would pop back up over their work every time.
  const dismissedVersion = useRef<string | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  function dismiss() {
    dismissedVersion.current = stateRef.current.version ?? null
    setDismissed(true)
  }
  const backdrop = useBackdropClose(dismiss)

  // The launch-time check can finish before this component has subscribed
  // below, and its 'available' event is one-shot — pull the current state
  // once on mount so an update found at startup is never missed.
  useEffect(() => {
    window.electronAPI?.getUpdateState?.().then((s) => {
      if (!s) return
      const next = s as unknown as UpdateState
      setState(next)
      setDismissed(false)
    }).catch(() => {})
  }, [])

  // An admin's "please update" notice re-opens a dismissed update dialog.
  useEffect(() => {
    const reopen = () => { dismissedVersion.current = null }
    window.addEventListener(UPDATE_RECHECK_EVENT, reopen)
    return () => window.removeEventListener(UPDATE_RECHECK_EVENT, reopen)
  }, [])

  useEffect(() => {
    if (!window.electronAPI?.onUpdateStatus) return
    return window.electronAPI.onUpdateStatus((s) => {
      const next = s as unknown as UpdateState
      setState(next)
      if (next.status === 'available') {
        if (next.version !== dismissedVersion.current) setDismissed(false)
        setAutoInstall(false)
      }
      if (next.status === 'downloaded' && autoInstall) {
        window.electronAPI?.installUpdate()
      }
    })
  }, [autoInstall])

  if (dismissed) return null
  if (!['available', 'downloading', 'downloaded'].includes(state.status)) return null

  function updateNow() {
    setAutoInstall(true)
    window.electronAPI?.downloadUpdate()
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200]" {...backdrop}>
      <div className="rh-card w-[440px] max-h-[70vh] overflow-y-auto p-6 flex flex-col gap-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-base font-semibold">Доступне оновлення {state.version}</h2>
          <p className="text-xs text-rh-muted mt-1">RaccoonHouse Studio</p>
        </div>

        {state.releaseNotes && (
          <MiniMarkdown
            text={state.releaseNotes}
            className="text-xs text-rh-text-dim leading-relaxed flex flex-col gap-1 bg-rh-bg border border-rh-border rounded-lg p-3 max-h-56 overflow-y-auto"
          />
        )}

        {state.status === 'downloading' && (
          <div className="flex items-center gap-2 text-xs text-rh-text-dim">
            <Spinner size={14} />
            Завантаження… {state.percent ?? 0}%
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={dismiss} className="rh-btn-ghost">
            Пізніше
          </button>
          {state.status === 'available' && (
            <button onClick={updateNow} className="rh-btn-primary">
              Оновити
            </button>
          )}
          {(state.status === 'downloading' || (state.status === 'downloaded' && autoInstall)) && (
            <button className="rh-btn-primary" disabled>
              <Spinner size={14} />
              {state.status === 'downloading' ? 'Завантаження…' : 'Встановлення…'}
            </button>
          )}
          {state.status === 'downloaded' && !autoInstall && (
            <button onClick={() => window.electronAPI?.installUpdate()} className="rh-btn-primary">
              Перезапустити й встановити
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
