import React, { useEffect, useState } from 'react'
import { Spinner } from './ui/Spinner'
import { useApi } from '../hooks/useApi'
import { MiniMarkdown } from '../utils/miniMarkdown'

interface UpdateState {
  status: string
  version?: string
  percent?: number
  message?: string
  releaseNotes?: string
}

interface UpdatePanelProps {
  isAdmin?: boolean
  // See PowerSharePanel's identical prop — SettingsPage's tabbed layout
  // puts this panel alone in its own pane now, not stacked below others.
  noTopMargin?: boolean
}

export function UpdatePanel({ isAdmin, noTopMargin }: UpdatePanelProps) {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const available = Boolean(window.electronAPI?.onUpdateStatus)
  const { post } = useApi()
  const [broadcasting, setBroadcasting] = useState(false)
  const [broadcastResult, setBroadcastResult] = useState<string | null>(null)

  async function broadcastForceUpdate() {
    setBroadcasting(true)
    setBroadcastResult(null)
    try {
      const r = await post<{ sent: number }>('/power-share/broadcast-force-update', {})
      setBroadcastResult(r.sent > 0 ? `Надіслано ${r.sent} ПК` : 'Немає нікого онлайн зараз')
    } catch (e) {
      setBroadcastResult(e instanceof Error ? e.message : 'Не вдалося надіслати')
    } finally {
      setBroadcasting(false)
    }
  }

  useEffect(() => {
    if (!window.electronAPI?.onUpdateStatus) return
    return window.electronAPI.onUpdateStatus((s) => setState(s as unknown as UpdateState))
  }, [])

  if (!available) return null

  function check() {
    setState({ status: 'checking' })
    window.electronAPI?.checkForUpdate()
  }

  function download() {
    window.electronAPI?.downloadUpdate()
  }
  function install() {
    window.electronAPI?.installUpdate()
  }

  const label = (() => {
    switch (state.status) {
      case 'checking': return 'Перевірка оновлень…'
      case 'available': return `Доступне оновлення ${state.version ?? ''}`
      case 'downloading': return `Завантаження оновлення… ${state.percent ?? 0}%`
      case 'downloaded': return `Оновлення ${state.version ?? ''} завантажено — готове до встановлення`
      case 'not-available': return 'Встановлено останню версію'
      case 'error': {
        const msg = state.message ?? ''
        if (/404|cannot find latest|no published versions|release not found/i.test(msg)) {
          return 'На GitHub ще немає жодного опублікованого релізу — це очікувано, доки не виконано npm run publish'
        }
        return `Помилка перевірки оновлень: ${msg}`
      }
      default: return 'Оновлення застосунку'
    }
  })()

  return (
    <div className={`bg-rh-card border border-rh-border rounded-2xl overflow-hidden ${noTopMargin ? '' : 'mt-5'}`}>
      <div className="flex items-center gap-3 py-3.5 px-4">
        <div className="flex-1">
          <div className="text-[12.5px] font-bold">Оновлення</div>
          <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">{label}</div>
        </div>
        {state.status === 'downloaded' ? (
          <button onClick={install} className="rh-btn-primary text-[11px] px-3 py-1.5">
            Перезапустити й встановити
          </button>
        ) : state.status === 'available' ? (
          <button onClick={download} className="rh-btn-primary text-[11px] px-3 py-1.5">
            Завантажити
          </button>
        ) : (
          <button
            onClick={check}
            className="rh-btn-outline text-[11px] px-3 py-1.5"
            disabled={state.status === 'checking' || state.status === 'downloading'}
          >
            {state.status === 'checking' ? <Spinner size={12} /> : null}
            Перевірити зараз
          </button>
        )}
      </div>
      {state.releaseNotes && (state.status === 'available' || state.status === 'downloading' || state.status === 'downloaded') && (
        <MiniMarkdown
          text={state.releaseNotes}
          className="text-[11px] text-rh-text-dim leading-relaxed flex flex-col gap-1 px-4 pb-3.5 border-t border-rh-border/70 pt-3"
        />
      )}
      {isAdmin && (
        <div className="flex items-center gap-3 py-3 px-4 border-t border-rh-border/70">
          <div className="flex-1">
            <div className="text-[12px] font-semibold">Попросити всіх оновитись</div>
            <div className="font-mono text-[10.5px] text-rh-text-dim mt-0.5">
              {broadcastResult ?? 'Надсилає нагадування кожному ПК, що зараз онлайн'}
            </div>
          </div>
          <button
            onClick={broadcastForceUpdate}
            disabled={broadcasting}
            className="rh-btn-outline text-[11px] px-3 py-1.5"
          >
            {broadcasting ? <Spinner size={12} /> : null}
            Надіслати всім
          </button>
        </div>
      )}
    </div>
  )
}
