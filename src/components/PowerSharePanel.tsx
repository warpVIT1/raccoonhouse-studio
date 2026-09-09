import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { Spinner } from './ui/Spinner'
import { Toggle } from './ui/Toggle'
import { PeerLogViewerModal } from './PeerLogViewerModal'

interface DiscoveredPeer {
  id: string
  name: string
  power_share_enabled: boolean
  logged_in: boolean
  gpu_name: string
  vram_gb: number
  available: boolean
}
interface Overview {
  this_machine_enabled: boolean
  own_gpu_name: string
  own_vram_gb: number
  total_peers: number
  available_peers: number
  peers: DiscoveredPeer[]
}

interface PowerSharePanelProps {
  powerShareEnabled: boolean
  onToggle: (enabled: boolean) => void
  powerShareAutoApprove: boolean
  onToggleAutoApprove: (enabled: boolean) => void
  onlineSignalingEnabled: boolean
  onlineSignalingUrl: string | null
  onSaveOnlineSignaling: (enabled: boolean, url: string | null) => void
  // SettingsPage's tabbed layout puts this panel alone in its own tab pane
  // rather than stacked below another card — the mt-5 that made sense
  // between stacked cards would just be a stray gap above the first thing
  // in the pane.
  noTopMargin?: boolean
}

export function PowerSharePanel({
  powerShareEnabled, onToggle, powerShareAutoApprove, onToggleAutoApprove,
  onlineSignalingEnabled, onlineSignalingUrl, onSaveOnlineSignaling, noTopMargin,
}: PowerSharePanelProps) {
  const { get } = useApi()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const data = await get<Overview>('/power-share/overview')
        if (!cancelled) setOverview(data)
      } catch {
        if (!cancelled) setOverview(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    poll()
    const interval = setInterval(poll, 4000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [get])

  return (
    <div className={`bg-rh-card border border-rh-border rounded-2xl overflow-hidden ${noTopMargin ? '' : 'mt-5'}`}>
      {/* Master toggle */}
      <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
        <div className="flex-1">
          <div className="text-[12.5px] font-bold">Розподілена обробка потужності</div>
          <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
            Дозволяє іншим у групі надсилати запит на відокремлення вокалу на цей ПК
          </div>
        </div>
        <Toggle checked={powerShareEnabled} onChange={onToggle} className="flex-shrink-0" />
      </div>

      {/* Auto-approve toggle — every request still prompts this machine's
          UI for a Так/Ні click by default; this skips that entirely. */}
      <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
        <div className="flex-1">
          <div className="text-[12.5px] font-bold">Автоматично надавати доступ</div>
          <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
            Без цього — кожен запит питає підтвердження (Так/Ні) на цьому ПК
          </div>
        </div>
        <Toggle checked={powerShareAutoApprove} onChange={onToggleAutoApprove} className="flex-shrink-0" />
      </div>

      {/* "Пристрої онлайн" used to be one of two sub-tabs, alongside a
          "Загальна потужність" bar-chart view (removed — not useful in
          practice, just a VRAM comparison chart with no action attached
          to it) — no more tab switcher needed with only one view left. */}
      {loading ? (
        <div className="flex justify-center py-8"><Spinner size={20} className="text-rh-accent" /></div>
      ) : !overview ? (
        <div className="p-4 text-xs text-rh-muted">Не вдалося отримати дані.</div>
      ) : (
        <DevicesList
          overview={overview}
          onlineSignalingEnabled={onlineSignalingEnabled}
          onlineSignalingUrl={onlineSignalingUrl}
          onSaveOnlineSignaling={onSaveOnlineSignaling}
        />
      )}
    </div>
  )
}

interface DevicesListProps {
  overview: Overview
  onlineSignalingEnabled: boolean
  onlineSignalingUrl: string | null
  onSaveOnlineSignaling: (enabled: boolean, url: string | null) => void
}
function DevicesList({
  overview, onlineSignalingEnabled, onlineSignalingUrl, onSaveOnlineSignaling,
}: DevicesListProps) {
  const [editingOnline, setEditingOnline] = useState(false)
  const [onlineUrl, setOnlineUrl] = useState(onlineSignalingUrl ?? '')
  const isAdmin = !!useAppStore((s) => s.activeProfile)?.is_admin
  const [viewingLogsFor, setViewingLogsFor] = useState<DiscoveredPeer | null>(null)

  return (
    <div className="p-4 flex flex-col gap-2.5">
      <p className="text-[11px] text-rh-text-dim -mt-1 mb-1">
        Усі ПК знаходять одне одного та обмінюються файлами виключно через сервер сигналізації
        нижче — жодного прямого з'єднання між ПК, без проброса портів і спільної мережі.
      </p>
      <div className="flex items-center gap-2.5 rounded-lg border border-rh-accent/30 bg-rh-accent/5 px-3 py-2">
        <span className="w-2 h-2 rounded-full bg-rh-accent flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">Цей ПК</div>
          <div className="font-mono text-[10.5px] text-rh-muted truncate">{overview.own_gpu_name} · {overview.own_vram_gb} ГБ</div>
        </div>
        <span className="text-[10.5px] text-rh-muted flex-shrink-0">
          {overview.this_machine_enabled ? 'Увімкнено' : 'Вимкнено'}
        </span>
      </div>
      {overview.peers.map((p) => (
        <div key={p.id} className="flex items-center gap-2.5 rounded-lg border border-rh-border px-3 py-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${p.available ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{p.name}</div>
            <div className="font-mono text-[10.5px] text-rh-muted truncate">{p.gpu_name} · {p.vram_gb} ГБ</div>
          </div>
          {isAdmin && (
            <button
              onClick={() => setViewingLogsFor(p)}
              className="rh-btn-ghost text-[10.5px] px-2 py-1 flex-shrink-0"
              title="Переглянути журнали цього ПК"
            >
              Логи
            </button>
          )}
          <span className="text-[10.5px] text-rh-muted flex-shrink-0">
            {p.available ? 'Готовий' : !p.power_share_enabled ? 'Вимкнено на ПК' : 'Не залогінено'}
          </span>
        </div>
      ))}
      {viewingLogsFor && (
        <PeerLogViewerModal
          peerId={viewingLogsFor.id}
          peerName={viewingLogsFor.name}
          onClose={() => setViewingLogsFor(null)}
        />
      )}
      {overview.peers.length === 0 && (
        <div className="text-xs text-rh-muted">Інших ПК поки не знайдено.</div>
      )}

      <div className="border-t border-rh-border pt-3 mt-1">
        {editingOnline ? (
          <div className="flex flex-col gap-2">
            <p className="text-[10.5px] text-rh-text-dim">
              Адреса сервера сигналізації (wss://) — див. cloudflare-signaling/README.md
              для розгортання власного.
            </p>
            <input
              className="rh-input"
              placeholder="wss://raccoonhouse-signaling.your-subdomain.workers.dev/"
              value={onlineUrl}
              onChange={(e) => setOnlineUrl(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEditingOnline(false)} className="rh-btn-ghost">Скасувати</button>
              <button
                onClick={() => {
                  const trimmed = onlineUrl.trim() || null
                  onSaveOnlineSignaling(!!trimmed, trimmed)
                  setEditingOnline(false)
                }}
                className="rh-btn-primary"
              >
                Зберегти
              </button>
            </div>
          </div>
        ) : onlineSignalingUrl ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-rh-border px-3 py-2">
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${onlineSignalingEnabled ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            <span className="text-xs font-medium flex-1 truncate">Онлайн: {onlineSignalingUrl}</span>
            <button
              onClick={() => onSaveOnlineSignaling(!onlineSignalingEnabled, onlineSignalingUrl)}
              className="rh-btn-ghost text-[11px] px-2 py-1"
            >
              {onlineSignalingEnabled ? 'Вимкнути' : 'Увімкнути'}
            </button>
            <button onClick={() => setEditingOnline(true)} className="rh-btn-ghost text-[11px] px-2 py-1">Змінити</button>
            <button onClick={() => onSaveOnlineSignaling(false, null)} className="text-rh-muted hover:text-red-400 text-xs px-1">✕</button>
          </div>
        ) : (
          <button onClick={() => setEditingOnline(true)} className="rh-btn-outline w-full">
            + Підключити онлайн (через інтернет)
          </button>
        )}
      </div>
    </div>
  )
}
