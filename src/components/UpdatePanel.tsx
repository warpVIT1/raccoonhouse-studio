import React, { useEffect, useState } from 'react'
import { Spinner } from './ui/Spinner'

interface UpdateState {
  status: string
  version?: string
  percent?: number
  message?: string
}

export function UpdatePanel() {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const available = Boolean(window.electronAPI?.onUpdateStatus)

  useEffect(() => {
    if (!window.electronAPI?.onUpdateStatus) return
    return window.electronAPI.onUpdateStatus((s) => setState(s as unknown as UpdateState))
  }, [])

  if (!available) return null

  function check() {
    setState({ status: 'checking' })
    window.electronAPI?.checkForUpdate()
  }

  function install() {
    window.electronAPI?.installUpdate()
  }

  const label = (() => {
    switch (state.status) {
      case 'checking': return 'Перевірка оновлень…'
      case 'available': return `Доступне оновлення ${state.version ?? ''} — завантаження…`
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
    <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden mt-5">
      <div className="flex items-center gap-3 py-3.5 px-4">
        <div className="flex-1">
          <div className="text-[12.5px] font-bold">Оновлення</div>
          <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">{label}</div>
        </div>
        {state.status === 'downloaded' ? (
          <button onClick={install} className="rh-btn-primary text-[11px] px-3 py-1.5">
            Перезапустити й встановити
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
    </div>
  )
}
