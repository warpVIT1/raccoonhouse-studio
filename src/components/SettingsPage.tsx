import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { PowerSharePanel } from './PowerSharePanel'
import { UpdatePanel } from './UpdatePanel'
import type { AppSettings, CacheInfo } from '../types'

const EMPTY_SETTINGS: AppSettings = {
  reaper_path: null,
  separation_model: 'MDX-Net',
  ensemble_default: false,
  position_format: 'time',
  default_bpm: null,
  cache_dir: null,
  available_models: ['MDX-Net', 'VR Arch', 'Demucs', 'MDX23C', 'BS-RoFormer'],
  active_profile_id: null,
  active_profile: null,
  power_share_enabled: false,
  manual_peer_host: null,
  manual_peer_port: 8765,
}

const EMPTY_CACHE: CacheInfo = { cache_dir: '', size_bytes: 0, size_label: '—', file_count: 0 }

export function SettingsPage() {
  const { get, put, post } = useApi()
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS)
  const [cache, setCache] = useState<CacheInfo>(EMPTY_CACHE)
  const [editingModel, setEditingModel] = useState(false)
  const [editingReaper, setEditingReaper] = useState(false)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    get<AppSettings>('/settings').then(setSettings).catch(() => {})
    get<CacheInfo>('/settings/cache-info').then(setCache).catch(() => {})
  }, [get])

  const save = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    try {
      const saved = await put<AppSettings>('/settings', patch)
      setSettings(saved)
    } catch {
      /* keep optimistic local state if backend unreachable */
    }
  }

  const pickReaperExe = async () => {
    if (window.electronAPI?.openFile) {
      const path = await window.electronAPI.openFile({
        filters: [{ name: 'Reaper', extensions: ['exe'] }],
      })
      if (path) await save({ reaper_path: path })
    } else {
      setEditingReaper(true)
    }
  }

  const clearCache = async () => {
    setClearing(true)
    try {
      const result = await post<CacheInfo>('/settings/cache/clear')
      setCache(result)
    } catch {
      setCache({ ...cache, size_label: '0 Б', file_count: 0 })
    } finally {
      setClearing(false)
    }
  }

  return (
    <main className="relative z-[1] p-5 px-6 max-w-[760px] overflow-y-auto h-full">
      <h1 className="m-0 mb-3.5 text-lg font-black">Налаштування</h1>

      <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
        {/* Reaper path */}
        <Row
          label="Шлях до Reaper"
          value={settings.reaper_path || 'Не вказано'}
          action={editingReaper ? undefined : 'Змінити'}
          onAction={pickReaperExe}
        >
          {editingReaper && (
            <InlinePathEditor
              initial={settings.reaper_path || ''}
              placeholder="C:\Program Files\REAPER\reaper.exe"
              onCancel={() => setEditingReaper(false)}
              onSave={(v) => { save({ reaper_path: v }); setEditingReaper(false) }}
            />
          )}
        </Row>

        {/* Separation model */}
        <Row
          label="Модель вокал-розділення"
          value={`${settings.separation_model}${settings.ensemble_default ? ' · Ensemble' : ''} · GPU`}
          action={editingModel ? undefined : 'Обрати'}
          onAction={() => setEditingModel(true)}
        >
          {editingModel && (
            <div className="flex flex-col gap-2 mt-2.5">
              <div className="flex flex-wrap gap-1.5">
                {settings.available_models.map((m) => (
                  <button
                    key={m}
                    onClick={() => save({ separation_model: m })}
                    className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-colors ${
                      settings.separation_model === m
                        ? 'bg-rh-accent/15 border-rh-accent/50 text-white'
                        : 'border-rh-border text-rh-text-dim hover:border-rh-accent/40 hover:text-white'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-[11.5px] text-rh-text-dim cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={settings.ensemble_default}
                  onChange={(e) => save({ ensemble_default: e.target.checked })}
                  className="accent-rh-accent"
                />
                Ensemble Mode — запускати кілька моделей і об'єднувати результат
              </label>
              <button
                onClick={() => setEditingModel(false)}
                className="self-start text-[11px] font-semibold text-rh-muted hover:text-white transition-colors"
              >
                Готово
              </button>
            </div>
          )}
        </Row>

        {/* Reaper marker position format */}
        <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
          <div className="flex-1">
            <div className="text-[12.5px] font-bold">Формат позиції маркерів Reaper</div>
            <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
              За замовчуванням для нових проєктів
            </div>
          </div>
          <div className="flex gap-1.5">
            <PillToggle
              active={settings.position_format === 'time'}
              onClick={() => save({ position_format: 'time' })}
              label="Час (ГГ:ХХ:СС.млс)"
            />
            <PillToggle
              active={settings.position_format === 'bars_beats'}
              onClick={() => save({ position_format: 'bars_beats' })}
              label="Bars.Beats.Ticks"
            />
          </div>
        </div>
        {settings.position_format === 'bars_beats' && (
          <div className="flex items-center gap-3 py-3 px-4 border-b border-rh-border/70">
            <div className="flex-1 text-[12px] text-rh-text-dim">BPM тайтлу (для розрахунку тактів)</div>
            <input
              type="number"
              min={1}
              value={settings.default_bpm ?? ''}
              onChange={(e) => save({ default_bpm: e.target.value ? Number(e.target.value) : null })}
              placeholder="120"
              className="w-20 bg-rh-bg border border-rh-border rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-rh-text focus:border-rh-accent/50 outline-none"
            />
          </div>
        )}

        {/* Proxy cache */}
        <Row
          label="Кеш прев'ю (480p)"
          value={`${cache.size_label} · ${cache.cache_dir}`}
          action={clearing ? 'Очищення…' : 'Очистити'}
          danger
          onAction={clearCache}
          last
        />
      </div>

      <PowerSharePanel
        powerShareEnabled={settings.power_share_enabled}
        onToggle={(v) => save({ power_share_enabled: v })}
        manualPeerHost={settings.manual_peer_host}
        manualPeerPort={settings.manual_peer_port}
        onSaveManualPeer={(host, port) => save({ manual_peer_host: host, manual_peer_port: port })}
      />
      <UpdatePanel />
    </main>
  )
}

function Row({
  label, value, action, onAction, danger, last, children,
}: {
  label: string
  value: string
  action?: string
  onAction?: () => void
  danger?: boolean
  last?: boolean
  children?: React.ReactNode
}) {
  return (
    <div className={`flex items-center gap-3 py-3.5 px-4 ${last ? '' : 'border-b border-rh-border/70'}`}>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-bold">{label}</div>
        <div className="font-mono text-[11px] text-rh-text-dim mt-0.5 truncate">{value}</div>
        {children}
      </div>
      {action && (
        <button
          onClick={onAction}
          className={`flex-none bg-transparent border rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors ${
            danger
              ? 'border-rh-border text-rh-muted hover:border-rh-accent/50 hover:text-[#FF6B70]'
              : 'border-rh-border text-rh-muted hover:border-rh-accent/40 hover:text-white'
          }`}
        >
          {action}
        </button>
      )}
    </div>
  )
}

function PillToggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-[10.5px] font-semibold border transition-colors ${
        active
          ? 'bg-rh-accent/15 border-rh-accent/50 text-white'
          : 'border-rh-border text-rh-text-dim hover:border-rh-accent/40 hover:text-white'
      }`}
    >
      {label}
    </button>
  )
}

function InlinePathEditor({
  initial, placeholder, onSave, onCancel,
}: {
  initial: string
  placeholder: string
  onSave: (v: string) => void
  onCancel: () => void
}) {
  const [v, setV] = useState(initial)
  return (
    <div className="flex gap-2 mt-2">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-rh-bg border border-rh-border rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-rh-text focus:border-rh-accent/50 outline-none"
      />
      <button onClick={() => onSave(v)} className="text-[11px] font-semibold text-rh-accent hover:text-rh-accent-h">
        Зберегти
      </button>
      <button onClick={onCancel} className="text-[11px] font-semibold text-rh-muted hover:text-white">
        Скасувати
      </button>
    </div>
  )
}
