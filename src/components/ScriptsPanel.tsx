import React, { useEffect, useState } from 'react'
import { Spinner } from './ui/Spinner'

interface ScriptEntry {
  filename: string
  title?: string
  description?: string
  version?: string
}

type RowStatus = { kind: 'installing' | 'saving' } | { kind: 'ok'; detail: string } | { kind: 'error'; detail: string } | null

interface ScriptsPanelProps {
  noTopMargin?: boolean
}

// Fetched straight from GitHub at runtime (see electron/main.ts's
// scripts:list), never bundled into the app itself — pushing a fixed
// script (and bumping its version in reaper-scripts/manifest.json) makes
// it show up here immediately, no new RaccoonHouse Studio release needed.
export function ScriptsPanel({ noTopMargin }: ScriptsPanelProps) {
  const available = !!window.electronAPI?.listScripts
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [status, setStatus] = useState<Record<string, RowStatus>>({})

  function load() {
    if (!available) { setLoading(false); return }
    setLoading(true)
    setLoadError(false)
    window.electronAPI!.listScripts()
      .then(setScripts)
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false))
  }
  useEffect(load, [available])

  async function install(filename: string) {
    setStatus((s) => ({ ...s, [filename]: { kind: 'installing' } }))
    try {
      const result = await window.electronAPI!.installScriptToReaper(filename)
      if (result.ok) {
        setStatus((s) => ({ ...s, [filename]: { kind: 'ok', detail: 'Встановлено — додайте дію в REAPER (Actions → New action → Load ReaScript)' } }))
      } else if (result.reason === 'no-reaper') {
        setStatus((s) => ({ ...s, [filename]: { kind: 'error', detail: 'REAPER не знайдено на цьому комп\'ютері' } }))
      } else if (result.reason === 'network') {
        setStatus((s) => ({ ...s, [filename]: { kind: 'error', detail: 'Немає з\'єднання — спробуйте ще раз' } }))
      } else {
        setStatus((s) => ({ ...s, [filename]: { kind: 'error', detail: 'Не вдалося встановити' } }))
      }
    } catch {
      setStatus((s) => ({ ...s, [filename]: { kind: 'error', detail: 'Не вдалося встановити' } }))
    }
  }

  async function saveAs(filename: string) {
    setStatus((s) => ({ ...s, [filename]: { kind: 'saving' } }))
    try {
      const dest = await window.electronAPI!.saveScriptAs(filename)
      setStatus((s) => ({ ...s, [filename]: dest ? { kind: 'ok', detail: `Збережено: ${dest}` } : null }))
    } catch {
      setStatus((s) => ({ ...s, [filename]: { kind: 'error', detail: 'Не вдалося зберегти' } }))
    }
  }

  if (!available) {
    return (
      <div className={noTopMargin ? '' : 'mt-4'}>
        <div className="text-xs text-rh-muted">Доступно лише в десктоп-застосунку.</div>
      </div>
    )
  }

  return (
    <div className={noTopMargin ? '' : 'mt-4'}>
      <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b border-rh-border/70 flex items-center justify-between gap-2">
          <div>
            <div className="text-[12.5px] font-bold">Скрипти екосистеми</div>
            <div className="text-[10.5px] text-rh-muted mt-0.5">
              Інструменти для команди, що працюють поза самою програмою — наприклад, у REAPER.
            </div>
          </div>
          <button onClick={load} disabled={loading} className="rh-btn-ghost text-[10.5px] px-2 py-1 flex-shrink-0 disabled:opacity-40">
            Оновити список
          </button>
        </div>
        {loading ? (
          <div className="px-4 py-4 flex justify-center"><Spinner size={16} className="text-rh-accent" /></div>
        ) : loadError ? (
          <div className="px-4 py-4 text-xs text-rh-muted">Не вдалося отримати список — перевірте з'єднання з інтернетом.</div>
        ) : (
          scripts.map((s) => {
            const st = status[s.filename] ?? null
            const busy = st?.kind === 'installing' || st?.kind === 'saving'
            return (
              <div key={s.filename} className="px-4 py-3 border-b border-rh-border/70 last:border-b-0 flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate">{s.title || s.filename}</div>
                    <div className="text-[10px] text-rh-muted font-mono truncate">
                      {s.filename}{s.version ? ` · v${s.version}` : ''}
                    </div>
                  </div>
                  <button
                    onClick={() => saveAs(s.filename)}
                    disabled={busy}
                    className="rh-btn-outline text-[10.5px] px-2.5 py-1.5 flex-shrink-0 disabled:opacity-40"
                  >
                    {st?.kind === 'saving' ? <Spinner size={11} /> : 'Зберегти як…'}
                  </button>
                  <button
                    onClick={() => install(s.filename)}
                    disabled={busy}
                    className="rh-btn-primary text-[10.5px] px-2.5 py-1.5 flex-shrink-0 disabled:opacity-40"
                  >
                    {st?.kind === 'installing' ? <Spinner size={11} /> : 'Встановити в REAPER'}
                  </button>
                </div>
                {s.description && (
                  <p className="text-[10.5px] text-rh-text-dim">{s.description}</p>
                )}
                {st && (st.kind === 'ok' || st.kind === 'error') && (
                  <div className={`text-[10.5px] ${st.kind === 'error' ? 'text-[#FF6B70]' : 'text-emerald-400'}`}>
                    {st.detail}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
