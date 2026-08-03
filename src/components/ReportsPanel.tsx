import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { Spinner } from './ui/Spinner'
import type { SeparationReport } from '../types'

// Admin-only (see SettingsPage — this whole panel is only rendered when
// the active profile is_admin) log of every separation run across every
// install in the group, relayed through the same Cloudflare Worker
// feedback/Апекс-sync already use (see cloudflare-signaling's /reports).
// started_at_utc is stored in UTC specifically so it can be rendered in
// THIS admin's own local time here, with whoever actually ran it own
// timezone shown alongside for reference — the two can easily differ across
// a distributed group.
export function ReportsPanel() {
  const { get, del } = useApi()
  const [reports, setReports] = useState<SeparationReport[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<SeparationReport | null>(null)
  const backdrop = useBackdropClose(() => setSelected(null))

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const data = await get<SeparationReport[]>('/reports')
        if (!cancelled) {
          setReports(data)
          setError(null)
          setSelected((prev) => (prev ? data.find((r) => r.id === prev.id) ?? null : null))
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не вдалося отримати список')
      }
    }
    poll()
    const interval = setInterval(poll, 15000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [get])

  async function dismiss(id: string) {
    setReports((prev) => prev?.filter((r) => r.id !== id) ?? null)
    try {
      await del(`/reports/${id}`)
    } catch {
      /* the next poll will bring it back if the delete didn't actually land */
    }
  }

  return (
    <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden mt-5">
      <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
        <div className="flex-1">
          <div className="text-[12.5px] font-bold">Звіти про розділення (тільки для адміна)</div>
          <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
            Хто запускав, яка модель, скільки часу, чи були помилки, хто допомагав
          </div>
        </div>
      </div>

      <div className="px-4 py-3 flex flex-col gap-2">
        {error && <div className="text-[11px] text-[#FF6B70]">{error}</div>}
        {reports === null && !error && (
          <div className="flex justify-center py-4"><Spinner size={16} className="text-rh-accent" /></div>
        )}
        {reports?.length === 0 && <div className="text-xs text-rh-muted">Поки що нічого немає.</div>}
        {reports?.map((r) => (
          <div
            key={r.id}
            onClick={() => setSelected(r)}
            className="flex items-start gap-2.5 rounded-lg border border-rh-border px-3 py-2 cursor-pointer hover:border-rh-accent/60 transition-colors"
          >
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 mt-1 ${
                r.status === 'success' ? 'bg-emerald-400' : r.status === 'cancelled' ? 'bg-zinc-500' : 'bg-[#FF6B70]'
              }`}
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium flex items-center gap-1.5 flex-wrap">
                <span>{r.episode_label}</span>
                <span className="text-rh-muted">·</span>
                <span className="text-amber-400">{r.model}{r.ensemble ? ' (ensemble)' : ''}</span>
              </div>
              <div className="font-mono text-[10.5px] text-rh-text-dim mt-0.5">
                {r.profile_name} · {r.duration_seconds.toFixed(0)}с · {r.status}
                {r.distributed && (
                  <> · розподілено{r.peers_used.length > 0 ? ` (допомагали: ${r.peers_used.join(', ')})` : ' (ніхто не допоміг)'}</>
                )}
              </div>
              {r.error_message && (
                <div className="text-[10.5px] text-[#FF6B70] mt-1 break-words line-clamp-1">{r.error_message}</div>
              )}
              {r.warnings.length > 0 && (
                <div className="text-[10px] text-amber-400/80 mt-1">
                  {r.warnings.length} тих{r.warnings.length === 1 ? 'а' : 'их'} попередження(-нь) — натисніть для деталей
                </div>
              )}
              <div className="font-mono text-[10px] text-rh-muted mt-1">
                {new Date(r.started_at_utc).toLocaleString()} ({r.user_timezone})
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); dismiss(r.id) }}
              className="text-rh-muted hover:text-emerald-400 text-sm leading-none px-1 flex-shrink-0"
              title="Прочитано"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      {selected && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
          {...backdrop}
        >
          <div
            className="rh-card w-[560px] max-w-full max-h-[80vh] overflow-y-auto p-6 flex flex-col gap-4 shadow-2xl select-text"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      selected.status === 'success' ? 'bg-emerald-400' : selected.status === 'cancelled' ? 'bg-zinc-500' : 'bg-[#FF6B70]'
                    }`}
                  />
                  {selected.episode_label}
                </h2>
                <div className="text-xs text-rh-text-dim mt-1">{selected.model}{selected.ensemble ? ' (ensemble)' : ''}</div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-rh-muted hover:text-rh-text text-lg leading-none px-1 flex-shrink-0"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
              <ReportField label="Статус" value={selected.status} />
              <ReportField label="Тривалість" value={`${selected.duration_seconds.toFixed(1)} с`} />
              <ReportField label="Хто запускав" value={selected.profile_name} />
              <ReportField label="Часовий пояс користувача" value={selected.user_timezone} />
              <ReportField
                label="Початок (ваш час)"
                value={new Date(selected.started_at_utc).toLocaleString()}
              />
              <ReportField
                label="Отримано на сервер"
                value={new Date(selected.created_at).toLocaleString()}
              />
              <ReportField label="Розподілено (Power Share)" value={selected.distributed ? 'Так' : 'Ні'} />
              <ReportField
                label="Допомагали"
                value={selected.distributed ? (selected.peers_used.length > 0 ? selected.peers_used.join(', ') : 'ніхто не допоміг') : '—'}
              />
            </div>

            {selected.error_message && (
              <div>
                <div className="text-[11px] font-semibold text-[#FF6B70] mb-1">Помилка</div>
                <div className="text-xs text-[#FF6B70] font-mono whitespace-pre-wrap break-words rounded-lg border border-[#FF6B70]/30 bg-[#FF6B70]/5 px-3 py-2">
                  {selected.error_message}
                </div>
              </div>
            )}

            {selected.warnings.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-amber-400 mb-1">
                  Попередження ({selected.warnings.length})
                </div>
                <div className="flex flex-col gap-1 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2">
                  {selected.warnings.map((w, i) => (
                    <div key={i} className="text-[11px] text-rh-text-dim font-mono whitespace-pre-wrap break-words">{w}</div>
                  ))}
                </div>
              </div>
            )}

            <div className="text-[10.5px] text-rh-muted font-mono">ID звіту: {selected.id}</div>
          </div>
        </div>
      )}
    </div>
  )
}

function ReportField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-rh-muted uppercase tracking-wide">{label}</div>
      <div className="font-mono text-rh-text-dim break-words">{value}</div>
    </div>
  )
}
