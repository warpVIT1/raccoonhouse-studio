import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { Spinner } from './ui/Spinner'

interface DiscoveredPeer {
  host: string
  port: number
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

// Fixed categorical order (validated for CVD-safe adjacency) — "you" is always
// the brand accent, "average" is always blue, peers rotate through the rest
// in this exact order (never reassigned by rank/filter).
const YOU_COLOR = '#E52128'
const AVERAGE_COLOR = '#3987e5'
const PEER_COLORS = ['#008300', '#d55181', '#c98500', '#199e70', '#d95926', '#9085e9']

interface PowerSharePanelProps {
  powerShareEnabled: boolean
  onToggle: (enabled: boolean) => void
  manualPeerHost: string | null
  manualPeerPort: number
  onSaveManualPeer: (host: string | null, port: number) => void
}

export function PowerSharePanel({
  powerShareEnabled, onToggle, manualPeerHost, manualPeerPort, onSaveManualPeer,
}: PowerSharePanelProps) {
  const { get } = useApi()
  const [tab, setTab] = useState<'devices' | 'overview'>('devices')
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
    <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden mt-5">
      {/* Master toggle */}
      <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
        <div className="flex-1">
          <div className="text-[12.5px] font-bold">Розподілена обробка потужності</div>
          <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
            Вимкнено за замовчуванням — дозволяє надсилати запит на відокремлення вокалу на потужніший ПК студії
          </div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
          <input
            type="checkbox"
            checked={powerShareEnabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-rh-border rounded-full peer-checked:bg-rh-accent transition-colors" />
          <div className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full transition-transform peer-checked:translate-x-4" />
        </label>
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 px-3 pt-2.5 border-b border-rh-border/70">
        <button
          onClick={() => setTab('devices')}
          className={`px-3 py-1.5 text-[11.5px] font-semibold border-b-2 transition-colors ${tab === 'devices' ? 'border-rh-accent text-white' : 'border-transparent text-rh-muted hover:text-white'}`}
        >
          Пристрої в мережі
        </button>
        <button
          onClick={() => setTab('overview')}
          className={`px-3 py-1.5 text-[11.5px] font-semibold border-b-2 transition-colors ${tab === 'overview' ? 'border-rh-accent text-white' : 'border-transparent text-rh-muted hover:text-white'}`}
        >
          Загальна потужність
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Spinner size={20} className="text-rh-accent" /></div>
      ) : !overview ? (
        <div className="p-4 text-xs text-rh-muted">Не вдалося отримати дані.</div>
      ) : tab === 'devices' ? (
        <DevicesList
          overview={overview}
          manualPeerHost={manualPeerHost}
          manualPeerPort={manualPeerPort}
          onSaveManualPeer={onSaveManualPeer}
        />
      ) : (
        <PowerChart overview={overview} />
      )}
    </div>
  )
}

interface DevicesListProps {
  overview: Overview
  manualPeerHost: string | null
  manualPeerPort: number
  onSaveManualPeer: (host: string | null, port: number) => void
}
function DevicesList({ overview, manualPeerHost, manualPeerPort, onSaveManualPeer }: DevicesListProps) {
  const [editingManual, setEditingManual] = useState(false)
  const [host, setHost] = useState(manualPeerHost ?? '')
  const [port, setPort] = useState(manualPeerPort)

  return (
    <div className="p-4 flex flex-col gap-2.5">
      <p className="text-[11px] text-rh-text-dim -mt-1 mb-1">
        Пристрої в тій самій локальній мережі виявляються автоматично. Якщо ПК одне одного не бачать
        (різні мережі, або з'єднання через VPN на кшталт Hamachi/Radmin), під'єднайтеся напряму нижче.
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
        <div key={`${p.host}:${p.port}`} className="flex items-center gap-2.5 rounded-lg border border-rh-border px-3 py-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${p.available ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{p.name}</div>
            <div className="font-mono text-[10.5px] text-rh-muted truncate">{p.host} · {p.gpu_name} · {p.vram_gb} ГБ</div>
          </div>
          <span className="text-[10.5px] text-rh-muted flex-shrink-0">
            {p.available ? 'Готовий' : !p.power_share_enabled ? 'Вимкнено на ПК' : 'Не залогінено'}
          </span>
        </div>
      ))}
      {overview.peers.length === 0 && (
        <div className="text-xs text-rh-muted">Інших ПК поки не знайдено.</div>
      )}

      <div className="border-t border-rh-border pt-3 mt-1">
        {editingManual ? (
          <div className="flex flex-col gap-2">
            <p className="text-[10.5px] text-rh-text-dim">
              IP-адреса (через проброс порту на роутері) або повне посилання тунелю,
              напр. ngrok: <span className="font-mono">https://xxxx.ngrok-free.app</span>
            </p>
            <div className="flex gap-2">
              <input
                className="rh-input flex-1"
                placeholder="91.201.xxx.xxx або https://xxxx.ngrok-free.app"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                autoFocus
              />
              <input
                className="rh-input w-20"
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || 8765)}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEditingManual(false)} className="rh-btn-ghost">Скасувати</button>
              <button
                onClick={() => { onSaveManualPeer(host.trim() || null, port); setEditingManual(false) }}
                className="rh-btn-primary"
              >
                Зберегти
              </button>
            </div>
          </div>
        ) : manualPeerHost ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-rh-border px-3 py-2">
            <span className="text-xs font-medium flex-1">Пряме з'єднання: {manualPeerHost}:{manualPeerPort}</span>
            <button onClick={() => setEditingManual(true)} className="rh-btn-ghost text-[11px] px-2 py-1">Змінити</button>
            <button onClick={() => onSaveManualPeer(null, 8765)} className="text-rh-muted hover:text-red-400 text-xs px-1">✕</button>
          </div>
        ) : (
          <button onClick={() => setEditingManual(true)} className="rh-btn-outline w-full">
            + Підключитися напряму за IP
          </button>
        )}
      </div>
    </div>
  )
}

function PowerChart({ overview }: { overview: Overview }) {
  const entries = [
    { key: 'you', label: 'Ви', gpu: overview.own_gpu_name, vram: overview.own_vram_gb, color: YOU_COLOR },
    ...overview.peers.map((p, i) => ({
      key: `${p.host}:${p.port}`,
      label: p.name,
      gpu: p.gpu_name,
      vram: p.vram_gb,
      color: PEER_COLORS[i % PEER_COLORS.length],
    })),
  ]
  const maxVal = Math.max(1, ...entries.map((e) => e.vram))
  const avg = entries.reduce((sum, e) => sum + e.vram, 0) / entries.length
  const avgPct = (avg / (maxVal * 1.15)) * 100
  const CHART_H = 160

  return (
    <div className="p-4 flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <StatTile label="Доступно зараз" value={`${overview.available_peers} / ${overview.total_peers}`} />
        <StatTile label="Середня потужність" value={`${avg.toFixed(1)} ГБ`} />
      </div>

      <div className="relative" style={{ height: CHART_H + 44 }}>
        {/* Average reference line */}
        <div
          className="absolute left-0 right-0 border-t border-dashed pointer-events-none"
          style={{ bottom: 44 + (avgPct / 100) * CHART_H, borderColor: AVERAGE_COLOR }}
        >
          <span
            className="absolute right-0 -top-4 text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded"
            style={{ color: AVERAGE_COLOR, background: 'rgba(57,135,229,0.12)' }}
          >
            середня {avg.toFixed(1)} ГБ
          </span>
        </div>

        {/* Bars */}
        <div className="absolute left-0 right-0 bottom-11 flex items-end gap-3 px-1" style={{ height: CHART_H }}>
          {entries.map((e) => {
            const heightPct = (e.vram / (maxVal * 1.15)) * 100
            return (
              <div key={e.key} className="flex-1 flex flex-col items-center justify-end h-full min-w-0" title={`${e.label} · ${e.gpu} · ${e.vram} ГБ`}>
                <span className="text-[11px] font-mono font-bold mb-1" style={{ color: e.color }}>
                  {e.vram} ГБ
                </span>
                <div
                  className="w-full rounded-t-md transition-all"
                  style={{ height: `${Math.max(2, heightPct)}%`, background: e.color }}
                />
              </div>
            )
          })}
        </div>

        {/* Labels */}
        <div className="absolute left-0 right-0 bottom-0 flex items-start gap-3 px-1 h-11">
          {entries.map((e) => (
            <div key={e.key} className="flex-1 min-w-0 text-center">
              <div className="text-[10.5px] font-semibold truncate">{e.label}</div>
              <div className="text-[9.5px] text-rh-muted truncate">{e.gpu}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-lg font-bold font-mono">{value}</span>
      <span className="text-[10.5px] text-rh-muted">{label}</span>
    </div>
  )
}
