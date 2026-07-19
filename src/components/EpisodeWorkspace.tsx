import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { VideoPlayer, type VideoPlayerHandle } from './workspace/VideoPlayer'
import { WaveformViewer } from './workspace/WaveformViewer'
import { SubtitleGrid } from './workspace/SubtitleGrid'
import { MarkersTab } from './workspace/MarkersTab'
import { Spinner } from './ui/Spinner'
import type { Episode, SubtitleLine, Marker, Character, Dubber, JobStatus } from '../types'

type WorkspaceTab = 'subtitles' | 'markers'

interface EpisodeWorkspaceProps {
  episodeId: number
  titleId: number
}

export function EpisodeWorkspace({ episodeId, titleId }: EpisodeWorkspaceProps) {
  const { get, post, put, del } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const backendPort = useAppStore((s) => s.backendPort)
  const setSelectedEpisode = useAppStore((s) => s.setSelectedEpisode)
  const activeJobs = useAppStore((s) => s.activeJobs)
  const upsertJob = useAppStore((s) => s.upsertJob)

  const [episode, setEpisode] = useState<Episode | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([])
  const [markers, setMarkers] = useState<Marker[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('subtitles')
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [duration, setDuration] = useState(0)

  // Video panel is resizable (by width, against the waveform) since a
  // fixed-width video felt too wide on most screens — dragged size is
  // remembered across episodes for the session.
  const [videoWidthPct, setVideoWidthPct] = useState(() => {
    const saved = Number(localStorage.getItem('rh_video_width_pct'))
    return saved >= 20 && saved <= 85 ? saved : 65
  })
  const topRowRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)

  // Separation panel state
  const SEPARATION_MODELS = ['MDX-Net', 'VR Arch', 'Demucs', 'MDX23C', 'BS-RoFormer'] as const
  const [showSeparationPanel, setShowSeparationPanel] = useState(false)
  const [sepModel, setSepModel] = useState<typeof SEPARATION_MODELS[number]>('MDX-Net')
  const [ensembleMode, setEnsembleMode] = useState(false)
  const [separating, setSeparating] = useState(false)
  const [powerShareEnabled, setPowerShareEnabled] = useState(false)
  const [requestingPower, setRequestingPower] = useState(false)
  const [powerShareError, setPowerShareError] = useState<string | null>(null)

  // Final render/mux
  const [rendering, setRendering] = useState(false)

  // ASS import
  const assInputRef = useRef<HTMLInputElement>(null)
  const [importingAss, setImportingAss] = useState(false)

  // Mux import
  const muxInputRef = useRef<HTMLInputElement>(null)

  const videoRef = useRef<VideoPlayerHandle>(null)

  // Load episode data
  useEffect(() => {
    if (!backendReady) return
    setLoading(true)
    Promise.all([
      get<Episode>(`/episodes/${episodeId}`),
      get<SubtitleLine[]>(`/episodes/${episodeId}/subtitle-lines`),
      get<Marker[]>(`/episodes/${episodeId}/markers`),
      get<Character[]>(`/characters?title_id=${titleId}`),
    ])
      .then(([ep, subs, mkrs, chars]) => {
        setEpisode(ep)
        setSubtitles(subs)
        setMarkers(mkrs)
        setCharacters(chars)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [backendReady, episodeId, titleId, get])

  useEffect(() => {
    if (!backendReady) return
    get<{ power_share_enabled: boolean }>('/settings').then((s) => setPowerShareEnabled(s.power_share_enabled)).catch(() => {})
  }, [backendReady, get])

  // Live-refresh: when any background job for this episode finishes (ASS
  // import, separation, marker detection...), refetch its data automatically
  // instead of requiring the user to leave and re-enter the episode.
  const handledJobIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!backendReady) return
    for (const job of activeJobs.values()) {
      if (job.episode_id !== episodeId) continue
      if (job.status === 'error' && job.type === 'request_remote_separation') {
        // Surfaces the exact deny reason (per-peer) from the background job —
        // otherwise a remote-power failure would only ever show up as a
        // silently-vanished spinner in the title bar.
        if (!handledJobIdsRef.current.has(job.id)) {
          handledJobIdsRef.current.add(job.id)
          setPowerShareError(job.message || 'Не вдалося отримати потужність')
        }
        continue
      }
      if (job.status !== 'complete') continue
      if (handledJobIdsRef.current.has(job.id)) continue
      handledJobIdsRef.current.add(job.id)

      get<Episode>(`/episodes/${episodeId}`).then(setEpisode).catch(() => {})
      get<SubtitleLine[]>(`/episodes/${episodeId}/subtitle-lines`).then(setSubtitles).catch(() => {})
      get<Marker[]>(`/episodes/${episodeId}/markers`).then(setMarkers).catch(() => {})
      // ASS import can create new characters — without this, the actor
      // dropdown for freshly-imported lines shows "—" until you leave and
      // re-enter the episode, since `characters` was only ever fetched once
      // on initial mount.
      get<Character[]>(`/characters?title_id=${titleId}`).then(setCharacters).catch(() => {})
    }
  }, [activeJobs, backendReady, episodeId, titleId, get])

  // Sync active subtitle to playhead
  useEffect(() => {
    if (!subtitles.length) return
    const idx = subtitles.findIndex(
      (s) => currentTimeMs >= s.start_ms && currentTimeMs <= s.end_ms
    )
    setActiveSubIndex(idx >= 0 ? idx : null)
  }, [currentTimeMs, subtitles])

  // Keyboard shortcuts: Space play/pause, Left/Right seek ±2s (Shift ±10s).
  // Ignored while typing in any input/textarea/select so it doesn't hijack
  // normal text editing (subtitle text, marker names, timecodes...).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement)?.isContentEditable) return
      const v = videoRef.current
      if (!v) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (v.isPaused()) v.play(); else v.pause()
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        v.seek(Math.max(0, v.currentTime() - (e.shiftKey ? 10 : 2)))
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        v.seek(Math.min(v.duration() || Infinity, v.currentTime() + (e.shiftKey ? 10 : 2)))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const startVideoResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    let lastPct = videoWidthPct
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current || !topRowRef.current) return
      const rect = topRowRef.current.getBoundingClientRect()
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      lastPct = Math.min(85, Math.max(20, pct))
      setVideoWidthPct(lastPct)
    }
    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('rh_video_width_pct', String(lastPct))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [videoWidthPct])

  const handleTimeUpdate = useCallback((t: number) => {
    setCurrentTimeMs(Math.round(t * 1000))
  }, [])

  const handleSubLineClick = useCallback((idx: number) => {
    setActiveSubIndex(idx)
    const line = subtitles[idx]
    if (line && videoRef.current) {
      videoRef.current.seek(line.start_ms / 1000)
    }
  }, [subtitles])

  const handleSubLineChange = useCallback(async (idx: number, changes: Partial<SubtitleLine>) => {
    const line = subtitles[idx]
    if (!line) return
    const updated = { ...line, ...changes }
    setSubtitles((prev) => {
      const next = [...prev]
      next[idx] = updated
      return next
    })
    if (backendReady) {
      await put(`/subtitle-lines/${line.id}`, changes).catch(() => {})
    }
  }, [subtitles, backendReady, put])

  const handleAddSubLine = useCallback(async () => {
    const newLine: SubtitleLine = {
      id: Date.now(),
      episode_id: episodeId,
      start_ms: currentTimeMs,
      end_ms: currentTimeMs + 3000,
      text: '',
      character_id: null,
      ass_style: 'Default',
      is_overlap: false,
    }
    if (backendReady) {
      const created = await post<SubtitleLine>(`/episodes/${episodeId}/subtitle-lines`, {
        start_ms: newLine.start_ms,
        end_ms: newLine.end_ms,
        text: '',
        ass_style: 'Default',
      }).catch(() => newLine)
      setSubtitles((prev) => [...prev, created].sort((a, b) => a.start_ms - b.start_ms))
    } else {
      setSubtitles((prev) => [...prev, newLine].sort((a, b) => a.start_ms - b.start_ms))
    }
  }, [episodeId, currentTimeMs, backendReady, post])

  const handleDeleteSubLine = useCallback(async (idx: number) => {
    const line = subtitles[idx]
    if (!line) return
    setSubtitles((prev) => prev.filter((_, i) => i !== idx))
    if (backendReady) {
      await del(`/subtitle-lines/${line.id}`).catch(() => {})
    }
  }, [subtitles, backendReady, del])

  // Marker handlers
  const handleMarkerConfirm = useCallback(async (id: number) => {
    setMarkers((prev) => prev.map((m) => m.id === id ? { ...m, confirmed: true } : m))
    if (backendReady) await put(`/markers/${id}`, { confirmed: true }).catch(() => {})
  }, [backendReady, put])

  const handleMarkerEdit = useCallback(async (id: number, changes: Partial<Marker>) => {
    setMarkers((prev) => prev.map((m) => m.id === id ? { ...m, ...changes } : m))
    if (backendReady) await put(`/markers/${id}`, changes).catch(() => {})
  }, [backendReady, put])

  const handleMarkerDelete = useCallback(async (id: number) => {
    setMarkers((prev) => prev.filter((m) => m.id !== id))
    if (backendReady) await del(`/markers/${id}`).catch(() => {})
  }, [backendReady, del])

  const handleMarkerAdd = useCallback(async (positionSeconds: number, name: string) => {
    const newMarker: Marker = { id: Date.now(), episode_id: episodeId, reaper_name: name, position_seconds: positionSeconds, confirmed: true }
    if (backendReady) {
      const created = await post<Marker>(`/episodes/${episodeId}/markers`, { reaper_name: name, position_seconds: positionSeconds, confirmed: true }).catch(() => newMarker)
      setMarkers((prev) => [...prev, created])
    } else {
      setMarkers((prev) => [...prev, newMarker])
    }
  }, [episodeId, backendReady, post])

  // ASS import
  async function handleAssImport(files: FileList) {
    const file = files[0]
    if (!file) return
    setImportingAss(true)
    try {
      if (backendReady) {
        const fd = new FormData()
        fd.append('file', file)
        const result = await post<{ job_id: string }>(`/episodes/${episodeId}/import-ass`, { file_path: (file as File & { path?: string }).path ?? '' })
        upsertJob({ id: result.job_id, type: 'export_srt', status: 'running', percent: 0, message: 'Парсинг ASS…', episode_id: episodeId })
      }
    } catch {
      // ignore
    } finally {
      setImportingAss(false)
    }
  }

  // Export SRT
  async function handleExportSrt() {
    if (!backendReady) return
    try {
      const url = `http://localhost:${backendPort}/api/episodes/${episodeId}/export-srt`
      window.open(url, '_blank')
    } catch {
      // ignore
    }
  }

  // Vocal separation
  async function handleSeparate() {
    if (!backendReady || !episode?.original_file_path) return
    setSeparating(true)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/separate-vocals`, {
        model: sepModel,
        ensemble: ensembleMode,
      })
      upsertJob({
        id: result.job_id,
        type: 'separate_vocals',
        status: 'running',
        percent: 0,
        message: 'Ізоляція вокалу…',
        episode_id: episodeId,
      })
      setShowSeparationPanel(false)
    } catch {
      // ignore
    } finally {
      setSeparating(false)
    }
  }

  async function handleRequestRemotePower() {
    if (!backendReady) return
    setRequestingPower(true)
    setPowerShareError(null)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/request-remote-separation`, {
        model: sepModel,
        ensemble: ensembleMode,
      })
      upsertJob({
        id: result.job_id,
        type: 'request_remote_separation',
        status: 'running',
        percent: 0,
        message: 'Шукаю доступні ПК у мережі…',
        episode_id: episodeId,
      })
      setShowSeparationPanel(false)
    } catch (err) {
      setPowerShareError(err instanceof Error ? err.message : 'Не вдалося надіслати запит')
    } finally {
      setRequestingPower(false)
    }
  }

  // Detect markers
  async function handleDetectMarkers() {
    if (!backendReady) return
    const result = await post<{ job_id: string }>(`/episodes/${episodeId}/detect-markers`, {}).catch(() => null)
    if (result) {
      upsertJob({
        id: result.job_id,
        type: 'detect_markers',
        status: 'running',
        percent: 0,
        message: 'Виявлення маркерів…',
        episode_id: episodeId,
      })
    }
  }

  // Export Reaper CSV
  async function handleExportReaper() {
    if (!backendReady) return
    const url = `http://localhost:${backendPort}/api/episodes/${episodeId}/export-reaper-csv`
    window.open(url, '_blank')
  }

  // Final render: import the studio's finished Reaper mix and mux it against the original video
  async function handleRenderFile(files: FileList) {
    const file = files[0]
    if (!file || !backendReady) return
    const mixedAudioPath = (file as File & { path?: string }).path
    if (!mixedAudioPath) return
    setRendering(true)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/mux-audio`, {
        mixed_audio_path: mixedAudioPath,
      })
      upsertJob({
        id: result.job_id,
        type: 'mux_audio',
        status: 'running',
        percent: 0,
        message: 'Фінальний мультиплекс…',
        episode_id: episodeId,
      })
    } catch {
      // ignore
    } finally {
      setRendering(false)
    }
  }

  const episodeJob = [...activeJobs.values()].find(
    (j) => j.episode_id === episodeId && j.status === 'running'
  )

  const vocalIsolated = episode?.status === 'vocal_isolated' || episode?.status === 'marked' || episode?.status === 'ready'
  const allMarkersConfirmed = markers.length > 0 && markers.every((m) => m.confirmed)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-rh-border flex-shrink-0">
        <button
          onClick={() => setSelectedEpisode(null)}
          className="rh-btn-ghost px-2 py-1.5"
        >
          ← До серій
        </button>
        <div className="w-px h-4 bg-rh-border" />
        <span className="text-sm font-medium text-rh-text">
          Епізод {episode?.number ?? episodeId}
        </span>

        {/* Status chip */}
        {vocalIsolated && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-violet-900/40 text-violet-300 border border-violet-700/40">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            Нейромережа: вокал відокремлено
          </span>
        )}

        {episodeJob && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-amber-900/30 text-amber-300">
            <Spinner size={10} />
            {episodeJob.message} {episodeJob.percent > 0 ? `${episodeJob.percent}%` : ''}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Import ASS */}
          <button onClick={() => assInputRef.current?.click()} className="rh-btn-outline text-xs" disabled={importingAss}>
            {importingAss ? <Spinner size={12} /> : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            )}
            Імпорт ASS
          </button>
          <input ref={assInputRef} type="file" accept=".ass" className="hidden" onChange={(e) => { if (e.target.files) handleAssImport(e.target.files) }} />

          {/* Export SRT */}
          <button onClick={handleExportSrt} className="rh-btn-outline text-xs" disabled={!backendReady}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Експорт SRT
          </button>

          {/* Separate vocals */}
          <button
            onClick={() => setShowSeparationPanel(!showSeparationPanel)}
            className={`rh-btn-outline text-xs ${showSeparationPanel ? 'border-rh-accent text-rh-accent' : ''}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 003 3V9a3 3 0 01-6 0V4a3 3 0 013-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1"/><line x1="12" y1="18" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
            Ізоляція вокалу
          </button>

          {/* Detect markers */}
          <button onClick={handleDetectMarkers} className="rh-btn-outline text-xs" disabled={!vocalIsolated || !backendReady}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            Авто-маркери
          </button>

          {/* Export Reaper */}
          <button onClick={handleExportReaper} className="rh-btn-outline text-xs" disabled={!backendReady}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
            </svg>
            Reaper CSV
          </button>

          <div className="w-px h-4 bg-rh-border mx-1" />

          {!allMarkersConfirmed && (
            <span className="text-xs text-rh-muted">Підтвердіть усі маркери, щоб рендерити</span>
          )}
          <button
            onClick={() => muxInputRef.current?.click()}
            disabled={!allMarkersConfirmed || rendering}
            className={`text-xs font-bold rounded-lg px-4 py-2 transition-all
              ${allMarkersConfirmed
                ? 'bg-rh-accent text-white hover:bg-[#F03238] hover:shadow-[0_0_20px_rgba(229,33,40,0.3)]'
                : 'bg-rh-border text-rh-muted cursor-not-allowed'
              }`}
          >
            {rendering ? <Spinner size={12} /> : null}
            Рендерити фінальну доріжку
          </button>
          <input
            ref={muxInputRef}
            type="file"
            accept=".wav,.flac,.aac,.mp3,.m4a"
            className="hidden"
            onChange={(e) => { if (e.target.files) handleRenderFile(e.target.files) }}
          />
        </div>
      </div>

      {/* Separation panel */}
      {showSeparationPanel && (
        <div className="flex items-center gap-4 px-4 py-2.5 bg-rh-card border-b border-rh-border flex-shrink-0">
          <span className="text-xs text-rh-muted">Модель:</span>
          {SEPARATION_MODELS.map((m) => (
            <button
              key={m}
              onClick={() => setSepModel(m)}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors
                ${sepModel === m ? 'bg-rh-accent text-white' : 'text-rh-muted hover:text-rh-text hover:bg-white/5'}`}
            >
              {m}
            </button>
          ))}
          <div className="w-px h-4 bg-rh-border" />
          <label className="flex items-center gap-1.5 text-xs text-rh-text-dim cursor-pointer select-none">
            <input
              type="checkbox"
              checked={ensembleMode}
              onChange={(e) => setEnsembleMode(e.target.checked)}
              className="accent-rh-accent"
            />
            Ensemble Mode
          </label>
          <button onClick={handleSeparate} className="rh-btn-primary text-xs ml-2" disabled={separating || requestingPower || !episode?.original_file_path}>
            {separating ? <Spinner size={12} /> : null}
            Запустити
          </button>
          {powerShareEnabled && (
            <button onClick={handleRequestRemotePower} className="rh-btn-outline text-xs" disabled={separating || requestingPower || !episode?.original_file_path}>
              {requestingPower ? <Spinner size={12} /> : null}
              Запросити потужність
            </button>
          )}
          {!episode?.original_file_path && (
            <span className="text-xs text-rh-muted">Спочатку завантажте відео</span>
          )}
          {powerShareError && (
            <span className="text-xs text-red-400">{powerShareError}</span>
          )}
        </div>
      )}

      {/* Main workspace */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top: video + waveform — width split between them is resizable */}
        <div ref={topRowRef} className="flex p-2 flex-shrink-0" style={{ height: '42%' }}>
          {/* Video player */}
          <div style={{ width: `${videoWidthPct}%` }} className="min-w-0">
            <VideoPlayer
              ref={videoRef}
              src={episode?.original_file_path ?? null}
              subtitles={subtitles}
              activeSubIndex={activeSubIndex}
              onTimeUpdate={handleTimeUpdate}
              onDurationChange={setDuration}
            />
          </div>

          {/* Drag handle */}
          <div
            onMouseDown={startVideoResize}
            className="w-2 flex-shrink-0 cursor-col-resize group flex items-center justify-center"
            title="Перетягніть, щоб змінити розмір відео"
          >
            <div className="w-1 h-8 rounded-full bg-rh-border group-hover:bg-rh-accent transition-colors" />
          </div>

          {/* Waveform */}
          <div style={{ width: `calc(${100 - videoWidthPct}% - 8px)` }} className="flex-shrink-0">
            <WaveformViewer
              vocalStemPath={episode?.vocal_stem_path ?? null}
              currentTime={currentTimeMs / 1000}
              duration={duration}
              markers={markers}
              onSeek={(t) => videoRef.current?.seek(t)}
              onMarkerClick={(m) => videoRef.current?.seek(m.position_seconds)}
              backendPort={backendPort}
            />
          </div>
        </div>

        {/* Bottom: subtitle grid + markers */}
        <div className="flex flex-col flex-1 overflow-hidden border-t border-rh-border">
          {/* Tab bar */}
          <div className="flex items-center gap-0 px-2 border-b border-rh-border bg-rh-card2 flex-shrink-0">
            <TabButton active={activeTab === 'subtitles'} onClick={() => setActiveTab('subtitles')}>
              Репліки
              <span className="ml-1.5 text-rh-muted text-xs">{subtitles.length}</span>
            </TabButton>
            <TabButton active={activeTab === 'markers'} onClick={() => setActiveTab('markers')}>
              Маркери
              <span className="ml-1.5 text-rh-muted text-xs">{markers.length}</span>
            </TabButton>
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {activeTab === 'subtitles' ? (
              <SubtitleGrid
                lines={subtitles}
                characters={characters}
                activeIndex={activeSubIndex}
                currentTimeMs={currentTimeMs}
                onLineClick={handleSubLineClick}
                onLineChange={handleSubLineChange}
                onAddLine={handleAddSubLine}
                onDeleteLine={handleDeleteSubLine}
              />
            ) : (
              <MarkersTab
                markers={markers}
                characters={characters}
                onConfirm={handleMarkerConfirm}
                onEdit={handleMarkerEdit}
                onDelete={handleMarkerDelete}
                onAdd={handleMarkerAdd}
                onSeek={(t) => videoRef.current?.seek(t)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}
function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center px-4 py-2 text-xs font-medium border-b-2 transition-colors
        ${active
          ? 'border-rh-accent text-rh-text'
          : 'border-transparent text-rh-muted hover:text-rh-text'
        }`}
    >
      {children}
    </button>
  )
}
