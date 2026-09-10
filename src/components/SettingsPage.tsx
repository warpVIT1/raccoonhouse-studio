import React, { useEffect, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { PowerSharePanel } from './PowerSharePanel'
import { ReportsPanel } from './ReportsPanel'
import { ScriptsPanel } from './ScriptsPanel'
import { UpdatePanel } from './UpdatePanel'
import { Toggle } from './ui/Toggle'
import type { AppSettings, Profile } from '../types'

const EMPTY_SETTINGS: AppSettings = {
  reaper_path: null,
  separation_model: 'MDX-Net',
  ensemble_default: false,
  position_format: 'time',
  default_bpm: null,
  available_models: ['MDX-Net', 'VR Arch', 'Demucs', 'MDX23C', 'BS-RoFormer'],
  active_profile_id: null,
  active_profile: null,
  power_share_enabled: true,
  power_share_auto_approve: false,
  online_signaling_enabled: true,
  online_signaling_url: 'wss://raccoonhouse-signaling.raccoonhause.workers.dev/',
  show_feedback_inbox: false,
  gpu_enabled: false,
  gpu_available: false,
  gpu_runtime_installed: false,
  audio_separator_version: '0.44.3',
  audio_separator_update_version: null,
  beta_features_enabled: false,
  device_id: '',
  deepl_api_key: null,
  openai_api_key: null,
  gemini_api_key: null,
  sound_engineer_filename_template: null,
  backup_directory: null,
}

type SettingsTab = 'general' | 'performance' | 'collab' | 'scripts' | 'updates' | 'admin'

export function SettingsPage() {
  const { get, put, post } = useApi()
  const [settings, setSettings] = useState<AppSettings>(EMPTY_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [tab, setTab] = useState<SettingsTab>('general')
  const [editingModel, setEditingModel] = useState(false)
  const [editingReaper, setEditingReaper] = useState(false)
  const [gpuError, setGpuError] = useState<string | null>(null)
  const [libUpdateError, setLibUpdateError] = useState<string | null>(null)
  const [publishingLib, setPublishingLib] = useState(false)
  const [libPublishVersion, setLibPublishVersion] = useState('')
  const [libPublishUrl, setLibPublishUrl] = useState('')
  const [libPublishError, setLibPublishError] = useState<string | null>(null)
  const [deviceIdCopied, setDeviceIdCopied] = useState(false)
  const [notificationsPaused, setNotificationsPaused] = useState(false)
  const [notificationsBusy, setNotificationsBusy] = useState(false)
  // "How loaded is the server" (2026-09-09) — app-admin-only, see
  // team_service.get_server_stats's own comment on what this actually
  // measures: D1 (db_bytes) is just sync metadata and stays tiny; the real
  // "how full" number is the R2 transfer bucket, where actual video/audio
  // content sits while in transit between studio PCs.
  const [serverStats, setServerStats] = useState<{
    db_bytes: number; r2_bytes: number; r2_object_count: number; percent_of_free_tier: number
  } | null>(null)
  const [serverStatsError, setServerStatsError] = useState<string | null>(null)
  // Local Electron window preference (tray hide-on-close), not part of the
  // backend's AppSettings — read/written straight through electronAPI, not
  // the /settings PUT flow (see electron/main.ts). Absent entirely in a
  // plain browser/dev context with no electronAPI.
  const [backgroundModeSupported, setBackgroundModeSupported] = useState(false)
  const [backgroundMode, setBackgroundMode] = useState(false)
  const activeJobs = useAppStore((s) => s.activeJobs)
  const upsertJob = useAppStore((s) => s.upsertJob)
  const activeProfile = useAppStore((s) => s.activeProfile)
  const setActiveProfile = useAppStore((s) => s.setActiveProfile)

  const gpuInstallJob = [...activeJobs.values()].find(
    (j) => j.type === 'install_gpu_runtime' && j.status === 'running'
  )
  const libUpdateJob = [...activeJobs.values()].find(
    (j) => j.type === 'install_audio_separator_update' && j.status === 'running'
  )

  // EMPTY_SETTINGS.gpu_available is false, same as "genuinely no GPU" — so a
  // failed/slow first fetch (e.g. opened right as the backend was still
  // starting up) used to render "NVIDIA GPU not found" and the install
  // button stayed hidden until some unrelated save() happened to refetch
  // real data. Retrying here instead of silently giving up, and gating the
  // GPU row's text on settingsLoaded below, fixes both the false negative
  // and the need for an unrelated click to "unstick" it.
  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout>
    const fetchSettings = () => {
      get<AppSettings>('/settings')
        .then((s) => {
          if (cancelled) return
          setSettings(s)
          setSettingsLoaded(true)
        })
        .catch(() => {
          if (!cancelled) retryTimer = setTimeout(fetchSettings, 1500)
        })
    }
    fetchSettings()
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
    }
  }, [get])

  // Once the install job completes, the backend has already flipped
  // gpu_enabled on its own (see settings.py) — refetch so the toggle
  // reflects that without the user having to do anything else.
  useEffect(() => {
    const justFinished = [...activeJobs.values()].find(
      (j) =>
        (j.type === 'install_gpu_runtime' || j.type === 'install_audio_separator_update') &&
        j.status === 'complete'
    )
    if (justFinished) {
      get<AppSettings>('/settings').then(setSettings).catch(() => {})
    }
  }, [activeJobs, get])

  useEffect(() => {
    if (!window.electronAPI?.getBackgroundMode) return
    setBackgroundModeSupported(true)
    window.electronAPI.getBackgroundMode().then(setBackgroundMode).catch(() => {})
  }, [])

  // Admin-only tab disappearing out from under someone mid-view (e.g. their
  // own admin status just got revoked elsewhere) shouldn't leave them
  // stranded on a tab that no longer renders anything.
  useEffect(() => {
    if (tab === 'admin' && !settings.active_profile?.is_admin) setTab('general')
  }, [tab, settings.active_profile?.is_admin])

  useEffect(() => {
    if (tab !== 'admin' || !settings.active_profile?.is_admin) return
    get<{ paused: boolean }>('/settings/notifications-paused').then((r) => setNotificationsPaused(r.paused)).catch(() => {})
  }, [tab, settings.active_profile?.is_admin, get])

  useEffect(() => {
    if (tab !== 'admin' || !settings.active_profile?.is_admin) return
    setServerStatsError(null)
    get<{ db_bytes: number; r2_bytes: number; r2_object_count: number; percent_of_free_tier: number }>('/teams/admin/server-stats')
      .then(setServerStats)
      .catch(() => setServerStatsError('Не вдалося отримати статистику сервера'))
  }, [tab, settings.active_profile?.is_admin, get])

  const toggleBackgroundMode = async (v: boolean) => {
    setBackgroundMode(v)
    try {
      await window.electronAPI?.setBackgroundMode(v)
    } catch {
      /* main process logs the failure; toggle stays optimistic */
    }
  }

  const installGpuRuntime = async () => {
    setGpuError(null)
    try {
      const result = await post<{ job_id: string }>('/settings/install-gpu-runtime')
      upsertJob({
        id: result.job_id,
        type: 'install_gpu_runtime',
        status: 'running',
        percent: 0,
        message: 'Завантаження бібліотек CUDA…',
      })
    } catch (e) {
      setGpuError(e instanceof Error ? e.message : 'Не вдалося запустити встановлення')
    }
  }

  const installAudioSeparatorUpdate = async () => {
    setLibUpdateError(null)
    try {
      const result = await post<{ job_id: string }>('/settings/install-audio-separator-update')
      upsertJob({
        id: result.job_id,
        type: 'install_audio_separator_update',
        status: 'running',
        percent: 0,
        message: 'Завантаження…',
      })
    } catch (e) {
      setLibUpdateError(e instanceof Error ? e.message : 'Не вдалося запустити оновлення')
    }
  }

  const toggleNotificationsPaused = async () => {
    setNotificationsBusy(true)
    try {
      const result = await put<{ paused: boolean }>('/settings/notifications-paused', { paused: !notificationsPaused })
      setNotificationsPaused(result.paused)
    } catch {
      // ignore
    } finally {
      setNotificationsBusy(false)
    }
  }

  const publishAudioSeparatorVersion = async () => {
    if (!libPublishVersion.trim() || !libPublishUrl.trim()) return
    setPublishingLib(true)
    setLibPublishError(null)
    try {
      await put('/settings/audio-separator-version', { version: libPublishVersion.trim(), wheel_url: libPublishUrl.trim() })
      setLibPublishVersion('')
      setLibPublishUrl('')
      const s = await get<AppSettings>('/settings')
      setSettings(s)
    } catch (e) {
      setLibPublishError(e instanceof Error ? e.message : 'Не вдалося опублікувати')
    } finally {
      setPublishingLib(false)
    }
  }

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

  const isAdmin = !!settings.active_profile?.is_admin

  return (
    <main className="relative z-[1] h-full flex flex-col p-5 px-6 overflow-hidden">
      <div className="flex items-start justify-between gap-4 mb-4 flex-shrink-0">
        <h1 className="m-0 text-lg font-black">Налаштування</h1>
        <ProfileCorner profile={activeProfile} />
      </div>

      <div className="flex-1 flex gap-5 min-h-0 max-w-[1000px]">
        <nav className="w-[168px] flex-shrink-0 flex flex-col gap-1">
          <TabButton active={tab === 'general'} onClick={() => setTab('general')} label="Загальні" />
          <TabButton active={tab === 'performance'} onClick={() => setTab('performance')} label="Продуктивність" />
          <TabButton active={tab === 'collab'} onClick={() => setTab('collab')} label="Спільна робота" />
          <TabButton active={tab === 'scripts'} onClick={() => setTab('scripts')} label="Скрипти" />
          <TabButton active={tab === 'updates'} onClick={() => setTab('updates')} label="Оновлення" />
          {isAdmin && <TabButton active={tab === 'admin'} onClick={() => setTab('admin')} label="Адмін" />}
        </nav>

        <div className="flex-1 min-w-0 overflow-y-auto pr-1 pb-5">
          {tab === 'general' && (
            <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
              {/* Background mode — local Electron window preference, not synced
                  anywhere (see electron/main.ts's tray/close-interception logic).
                  Hidden entirely outside Electron (no electronAPI). */}
              {backgroundModeSupported && (
                <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
                  <div className="flex-1">
                    <div className="text-[12.5px] font-bold">Фоновий режим</div>
                    <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
                      Закриття вікна ховає програму в трей замість виходу — бекенд і Power Share продовжують працювати
                    </div>
                  </div>
                  <Toggle checked={backgroundMode} onChange={toggleBackgroundMode} className="flex-shrink-0" />
                </div>
              )}

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

              {/* Beta features — off by default. Gates experimental things still
                  being tested (first candidate: MVSep cloud separation) from
                  showing up at all until explicitly opted into. */}
              <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
                <div className="flex-1">
                  <div className="text-[12.5px] font-bold">Бета-функції</div>
                  <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
                    Показує ще тестові функції (напр. MVSep) — можуть працювати нестабільно
                  </div>
                </div>
                <Toggle
                  checked={settings.beta_features_enabled}
                  onChange={(v) => save({ beta_features_enabled: v })}
                  className="flex-shrink-0"
                />
              </div>

              {/* Fixed per-machine ID (see backend device_identity_service.py) —
                  read-only, shown so it can be read off to a team admin for an
                  invite. Not itself a Track-1 team feature, just surfacing the id. */}
              <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-bold">ID цього пристрою</div>
                  <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
                    Передайте адміну команди, щоб він міг вас додати
                  </div>
                  {/* select-all/select-text so a click-drag (or triple-click)
                      selects the id even though it's not an <input> — the copy
                      button below is the fast path, this is the fallback. */}
                  <input
                    readOnly
                    value={settings.device_id || '…'}
                    onFocus={(e) => e.target.select()}
                    className="mt-1.5 w-full max-w-[220px] bg-rh-bg border border-rh-border rounded-lg px-2 py-1 text-[11px] font-mono select-all"
                  />
                </div>
                <button
                  onClick={() => {
                    if (!settings.device_id) return
                    navigator.clipboard.writeText(settings.device_id).then(() => {
                      setDeviceIdCopied(true)
                      setTimeout(() => setDeviceIdCopied(false), 1500)
                    }).catch(() => {})
                  }}
                  className="flex-none bg-transparent border border-rh-border rounded-lg px-3 py-1.5 text-[11px] font-semibold text-rh-muted hover:border-rh-accent/40 hover:text-white transition-colors"
                >
                  {deviceIdCopied ? 'Скопійовано' : 'Копіювати'}
                </button>
              </div>

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
                <div className="flex items-center gap-3 py-3 px-4">
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
            </div>
          )}

          {tab === 'general' && (
            <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden mt-5">
              {/* Per-line machine translation — Translator role only (see
                  TranslatorWorkspace/SubtitleEditBox's DeepL/GPT buttons).
                  Deliberately per-install, not a studio-wide shared token
                  like MVSep's — each studio brings its own account. Round-
                  tripped in plaintext like every other setting on this page
                  (needed to actually call the APIs) — type="password" here
                  is just shoulder-surfing masking, not real encryption. */}
              <div className="py-3 px-4 border-b border-rh-border/70">
                <div className="text-[12.5px] font-bold">Переклад (роль Перекладач)</div>
                <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
                  API-ключі для перекладу реплік прямо в програмі — DeepL і/або OpenAI
                </div>
              </div>
              <div className="flex items-center gap-3 py-3 px-4 border-b border-rh-border/70">
                <div className="flex-1 text-[12px] text-rh-text-dim">DeepL API-ключ</div>
                <input
                  type="password"
                  value={settings.deepl_api_key ?? ''}
                  onChange={(e) => save({ deepl_api_key: e.target.value || null })}
                  placeholder="Не вказано"
                  className="w-64 bg-rh-bg border border-rh-border rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-rh-text focus:border-rh-accent/50 outline-none"
                />
              </div>
              <div className="flex items-center gap-3 py-3 px-4 border-b border-rh-border/70">
                <div className="flex-1 text-[12px] text-rh-text-dim">OpenAI API-ключ</div>
                <input
                  type="password"
                  value={settings.openai_api_key ?? ''}
                  onChange={(e) => save({ openai_api_key: e.target.value || null })}
                  placeholder="Не вказано"
                  className="w-64 bg-rh-bg border border-rh-border rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-rh-text focus:border-rh-accent/50 outline-none"
                />
              </div>
              <div className="flex items-center gap-3 py-3 px-4">
                <div className="flex-1 text-[12px] text-rh-text-dim">Gemini API-ключ</div>
                <input
                  type="password"
                  value={settings.gemini_api_key ?? ''}
                  onChange={(e) => save({ gemini_api_key: e.target.value || null })}
                  placeholder="Не вказано"
                  className="w-64 bg-rh-bg border border-rh-border rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-rh-text focus:border-rh-accent/50 outline-none"
                />
              </div>
            </div>
          )}

          {tab === 'general' && (
            <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden mt-5">
              {/* Only applies to a profile that actually holds the
                  sound_engineer role (see backend routers/actor_audio.py's
                  get_actor_audio_url) — the director's own download of the
                  same file always keeps the actor's real original name
                  regardless of this. Empty = keep the original name too. */}
              <div className="py-3 px-4 border-b border-rh-border/70">
                <div className="text-[12.5px] font-bold">Ім'я файлу при завантаженні (роль Звукорежисер)</div>
                <div className="font-mono text-[11px] text-rh-text-dim mt-0.5 leading-relaxed">
                  Порожньо — завантажується з оригінальною назвою файлу.<br />
                  Плейсхолдери (у будь-якому порядку, будь-яка кількість разів):{' '}
                  <span className="text-rh-text">&amp;title</span> — назва тайтлу,{' '}
                  <span className="text-rh-text">&amp;series</span> — S{'{сезон}'},{' '}
                  <span className="text-rh-text">&amp;episode</span> — E{'{серія}'},{' '}
                  <span className="text-rh-text">&amp;character</span> — персонаж,{' '}
                  <span className="text-rh-text">&amp;actor</span> — хто здав.
                </div>
              </div>
              <div className="flex items-center gap-3 py-3 px-4">
                <div className="flex-1 text-[12px] text-rh-text-dim">Шаблон назви</div>
                <input
                  value={settings.sound_engineer_filename_template ?? ''}
                  onChange={(e) => save({ sound_engineer_filename_template: e.target.value || null })}
                  placeholder="напр. &title_&series&episode_&character"
                  className="w-72 bg-rh-bg border border-rh-border rounded-lg px-2.5 py-1.5 text-[12px] font-mono text-rh-text focus:border-rh-accent/50 outline-none"
                />
              </div>
            </div>
          )}

          {tab === 'performance' && (
            <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
              {/* GPU acceleration — off by default, opt-in because enabling it
                  downloads a one-time ~2.5GB CUDA runtime (see gpu_runtime_service.py) */}
              <div className="flex items-center gap-3 py-3.5 px-4 border-b border-rh-border/70">
                <div className="flex-1 min-w-0">
                  <div className="text-[12.5px] font-bold">GPU-прискорення (усі моделі)</div>
                  <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
                    {!settingsLoaded
                      ? 'Перевірка…'
                      : !settings.gpu_available
                      ? 'NVIDIA GPU не знайдено на цьому комп\'ютері'
                      : gpuInstallJob
                        ? gpuInstallJob.message || 'Встановлення…'
                        : settings.gpu_enabled
                          ? 'Увімкнено — CUDA-бібліотеки встановлені'
                          : settings.gpu_runtime_installed
                            ? 'Бібліотеки вже завантажені, прискорення вимкнено'
                            : 'Вимкнено — розділення йде на CPU'}
                  </div>
                  {gpuInstallJob && (
                    <div className="mt-1.5 h-1 w-full max-w-[220px] rounded-full bg-rh-border overflow-hidden">
                      <div
                        className="h-full bg-rh-accent transition-all"
                        style={{ width: `${gpuInstallJob.percent}%` }}
                      />
                    </div>
                  )}
                  {gpuError && <div className="text-[11px] text-[#FF6B70] mt-1">{gpuError}</div>}
                </div>
                {settingsLoaded && settings.gpu_available && !gpuInstallJob && (
                  settings.gpu_enabled ? (
                    <button
                      onClick={() => save({ gpu_enabled: false })}
                      className="flex-none bg-transparent border border-rh-border rounded-lg px-3 py-1.5 text-[11px] font-semibold text-rh-muted hover:border-rh-accent/50 hover:text-[#FF6B70] transition-colors"
                    >
                      Вимкнути
                    </button>
                  ) : settings.gpu_runtime_installed ? (
                    <button
                      onClick={() => save({ gpu_enabled: true })}
                      className="flex-none bg-transparent border border-rh-border rounded-lg px-3 py-1.5 text-[11px] font-semibold text-rh-muted hover:border-rh-accent/40 hover:text-white transition-colors"
                    >
                      Увімкнути
                    </button>
                  ) : (
                    <button
                      onClick={installGpuRuntime}
                      className="flex-none bg-transparent border border-rh-border rounded-lg px-3 py-1.5 text-[11px] font-semibold text-rh-muted hover:border-rh-accent/40 hover:text-white transition-colors"
                    >
                      Завантажити й увімкнути
                    </button>
                  )
                )}
              </div>

              {/* audio-separator library version — admin can push a newer version
                  to the whole studio via the Worker (see lib_runtime_service.py),
                  no app update needed; everyone else just sees an "update
                  available" row here and confirms it themselves. */}
              <Row
                label="Бібліотека розділення (audio-separator)"
                value={
                  libUpdateJob
                    ? libUpdateJob.message || 'Встановлення…'
                    : settings.audio_separator_update_version
                      ? `Поточна: v${settings.audio_separator_version} → доступна v${settings.audio_separator_update_version}`
                      : `Версія v${settings.audio_separator_version} — оновлень немає`
                }
                action={settingsLoaded && settings.audio_separator_update_version && !libUpdateJob ? 'Оновити' : undefined}
                onAction={installAudioSeparatorUpdate}
                last
              >
                {libUpdateJob && (
                  <div className="mt-1.5 h-1 w-full max-w-[220px] rounded-full bg-rh-border overflow-hidden">
                    <div className="h-full bg-rh-accent transition-all" style={{ width: `${libUpdateJob.percent}%` }} />
                  </div>
                )}
                {libUpdateError && <div className="text-[11px] text-[#FF6B70] mt-1">{libUpdateError}</div>}
              </Row>
            </div>
          )}

          {tab === 'collab' && (
            <PowerSharePanel
              powerShareEnabled={settings.power_share_enabled}
              onToggle={(v) => save({ power_share_enabled: v })}
              powerShareAutoApprove={settings.power_share_auto_approve}
              onToggleAutoApprove={(v) => save({ power_share_auto_approve: v })}
              onlineSignalingEnabled={settings.online_signaling_enabled}
              onlineSignalingUrl={settings.online_signaling_url}
              onSaveOnlineSignaling={(enabled, url) => save({ online_signaling_enabled: enabled, online_signaling_url: url })}
              noTopMargin
            />
          )}

          {tab === 'scripts' && <ScriptsPanel noTopMargin />}

          {tab === 'updates' && <UpdatePanel isAdmin={isAdmin} noTopMargin />}

          {tab === 'admin' && isAdmin && (
            <div className="flex flex-col gap-5">
              {/* Global kill switch for automated Telegram notifications
                  (stage-handoff pings, per-actor SRT handoff) — doesn't
                  touch an admin's own manually-composed messages or
                  /feedback. Flipping it also pings everyone once so people
                  know why the bot went quiet / that it's back. */}
              <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
                <div className="flex items-center gap-3 py-3.5 px-4">
                  <div className="flex-1">
                    <div className="text-[12.5px] font-bold">Призупинити сповіщення в Telegram</div>
                    <div className="font-mono text-[11px] text-rh-text-dim mt-0.5">
                      Автоматичні нагадування про нові серії/репліки для всіх — власні повідомлення адміна не зачіпає
                    </div>
                  </div>
                  <Toggle
                    checked={notificationsPaused}
                    onChange={toggleNotificationsPaused}
                    className={notificationsBusy ? 'opacity-50 pointer-events-none' : ''}
                  />
                </div>
              </div>

              {/* Publish a new recommended audio-separator version for
                  everyone — thin wrapper around PUT /settings/audio-separator-version,
                  for whoever already has the PyPI wheel URL of a version
                  they've tested locally. */}
              <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
                <div className="flex flex-col gap-2 py-3.5 px-4">
                  <div className="text-[12.5px] font-bold">Опублікувати нову версію audio-separator</div>
                  <div className="flex gap-2">
                    <input
                      value={libPublishVersion}
                      onChange={(e) => setLibPublishVersion(e.target.value)}
                      placeholder="0.45.0"
                      className="w-24 bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px] font-mono"
                    />
                    <input
                      value={libPublishUrl}
                      onChange={(e) => setLibPublishUrl(e.target.value)}
                      placeholder="https://files.pythonhosted.org/.../audio_separator-0.45.0-py3-none-any.whl"
                      className="flex-1 min-w-0 bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px] font-mono"
                    />
                    <button
                      onClick={publishAudioSeparatorVersion}
                      disabled={publishingLib || !libPublishVersion.trim() || !libPublishUrl.trim()}
                      className="flex-none bg-transparent border border-rh-border rounded-lg px-3 py-1.5 text-[11px] font-semibold text-rh-muted hover:border-rh-accent/40 hover:text-white transition-colors disabled:opacity-40"
                    >
                      {publishingLib ? '…' : 'Опублікувати'}
                    </button>
                  </div>
                  {libPublishError && <div className="text-[11px] text-[#FF6B70]">{libPublishError}</div>}
                </div>
              </div>

              <ReportsPanel noTopMargin />

              {/* "How loaded is the server" — app-admin only (2026-09-09).
                  Not literal RAM (see team_service.get_server_stats' own
                  comment) — the shared D1 database's real on-disk size,
                  the honest storage-usage number this architecture
                  actually has available. */}
              <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
                <div className="flex flex-col gap-1 py-3.5 px-4">
                  <div className="text-[12.5px] font-bold">Навантаження сервера</div>
                  {serverStatsError ? (
                    <div className="font-mono text-[11px] text-rh-text-dim">{serverStatsError}</div>
                  ) : serverStats ? (
                    <div className="font-mono text-[11px] text-rh-text-dim flex flex-col gap-0.5">
                      <div>Сховище файлів: {serverStats.percent_of_free_tier.toFixed(1)}% від безкоштовного ліміту (10 ГБ)</div>
                      <div className="text-rh-text-dim/70">
                        {(serverStats.r2_bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ, {serverStats.r2_object_count} файлів · База даних: {(serverStats.db_bytes / (1024 * 1024)).toFixed(1)} МБ
                      </div>
                    </div>
                  ) : (
                    <div className="font-mono text-[11px] text-rh-text-dim">Завантаження…</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`text-left px-3 py-2 rounded-lg text-[12.5px] font-semibold transition-colors ${
        active ? 'bg-rh-accent/15 text-rh-accent' : 'text-rh-muted hover:text-white hover:bg-white/5'
      }`}
    >
      {label}
    </button>
  )
}

function ProfileCorner({ profile }: { profile: Profile | null }) {
  const [avatarFailed, setAvatarFailed] = useState(false)
  useEffect(() => { setAvatarFailed(false) }, [profile?.id])

  if (!profile) return null

  return (
    <div className="bg-rh-card border border-rh-border rounded-2xl px-3.5 py-3 flex items-start gap-2.5 w-[300px] flex-shrink-0">
      {profile.avatar_url && !avatarFailed ? (
        <img
          src={profile.avatar_url}
          alt={profile.name}
          onError={() => setAvatarFailed(true)}
          className="w-9 h-9 rounded-full object-cover flex-shrink-0"
        />
      ) : (
        <span
          className="w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-extrabold text-white flex-shrink-0"
          style={{ background: profile.color }}
        >
          {profile.name.slice(0, 2).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-bold truncate flex items-center gap-1.5">
          {profile.name}
          {profile.telegram_username && (
            <span className="text-[10px] font-normal text-sky-400 truncate">@{profile.telegram_username}</span>
          )}
        </div>
        {/* No self-service editing (2026-09-09) — roles are granted by a
            team admin (see TeamsPage's member list) or the app admin, not
            picked freely here anymore. Plain read-only label instead of
            <RolePicker>. */}
        <div className="text-[10.5px] text-rh-muted mt-1.5">
          {(profile.roles && profile.roles.length > 0) ? profile.roles.join(', ') : 'Актор'}
        </div>
      </div>
    </div>
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
