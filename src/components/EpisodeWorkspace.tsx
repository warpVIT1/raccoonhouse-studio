import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { VideoPlayer, type VideoPlayerHandle } from './workspace/VideoPlayer'
import { WaveformViewer } from './workspace/WaveformViewer'
import { SubtitleGrid } from './workspace/SubtitleGrid'
import { MarkersTab } from './workspace/MarkersTab'
import { Spinner } from './ui/Spinner'
import { VocalSeparationModal, type SeparationModel, type SeparationParams } from './VocalSeparationModal'
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
  const subtitlesUndoStackRef = useRef<SubtitleLine[][]>([])

  // Video panel is resizable both by width (against the waveform) and by
  // height (against the subtitles/markers grid below) — a fixed size felt
  // too wide/cramped on most screens. Both dragged sizes are remembered.
  const [videoWidthPct, setVideoWidthPct] = useState(() => {
    const saved = Number(localStorage.getItem('rh_video_width_pct'))
    return saved >= 20 && saved <= 85 ? saved : 65
  })
  const [videoHeightPct, setVideoHeightPct] = useState(() => {
    const saved = Number(localStorage.getItem('rh_video_height_pct'))
    return saved >= 20 && saved <= 75 ? saved : 42
  })
  const topRowRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)

  // Separation panel state
  const [showSeparationPanel, setShowSeparationPanel] = useState(false)
  const [separating, setSeparating] = useState(false)
  const [powerShareEnabled, setPowerShareEnabled] = useState(false)
  const [requestingPower, setRequestingPower] = useState(false)
  const [powerShareError, setPowerShareError] = useState<string | null>(null)
  const [separationError, setSeparationError] = useState<string | null>(null)
  const [batchRendering, setBatchRendering] = useState(false)
  const [batchResults, setBatchResults] = useState<{ jobId: string; items: { model: string; path: string }[] } | null>(null)
  const [usingBatchResult, setUsingBatchResult] = useState<string | null>(null)
  const [distributedRunning, setDistributedRunning] = useState(false)
  const [markersError, setMarkersError] = useState<string | null>(null)

  // Final render/mux
  const [rendering, setRendering] = useState(false)
  const [requestingRender, setRequestingRender] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)

  // ASS import
  const assInputRef = useRef<HTMLInputElement>(null)
  const [importingAss, setImportingAss] = useState(false)
  const [assDragOver, setAssDragOver] = useState(false)

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
      if (job.status === 'error') {
        // Surfaces the exact failure reason from the background job — without
        // this, ANY job failing (separation, marker detection, mux, remote
        // power request…) only ever showed up as a silently-vanished spinner,
        // indistinguishable from it never having started at all.
        if (!handledJobIdsRef.current.has(job.id)) {
          handledJobIdsRef.current.add(job.id)
          console.error(`[job ${job.type}] failed:`, job.message)
          if (job.type === 'request_remote_separation') {
            setPowerShareError(job.message || 'Не вдалося отримати потужність')
          } else if (job.type === 'separate_vocals' || job.type === 'batch_separate_vocals' || job.type === 'distributed_separate_vocals') {
            setSeparationError(job.message || 'Не вдалося виконати ізоляцію вокалу')
          } else if (job.type === 'detect_markers') {
            setMarkersError(job.message || 'Не вдалося виявити маркери')
          } else if (job.type === 'mux_audio' || job.type === 'request_remote_render') {
            setRenderError(job.message || 'Не вдалося відрендерити фінальне відео')
          }
        }
        continue
      }
      if (job.status !== 'complete') continue
      if (handledJobIdsRef.current.has(job.id)) continue
      handledJobIdsRef.current.add(job.id)

      // Batch mode deliberately never touches the episode's own fields (see
      // separate_file_batch's docstring) — its N separate FLAC files have no
      // other home in the UI, so the only way the user actually sees them is
      // opening the folder they landed in directly.
      if (job.type === 'batch_separate_vocals') {
        const outputDir = job.result?.output_dir
        if (typeof outputDir === 'string' && window.electronAPI?.openPath) {
          window.electronAPI.openPath(outputDir).catch((err) => console.error('[batch] failed to open output folder:', err))
        }
        const models = job.result?.models
        if (models && typeof models === 'object') {
          setBatchResults({
            jobId: job.id,
            items: Object.entries(models as Record<string, string>).map(([model, path]) => ({ model, path })),
          })
        }
        continue
      }

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

  const startVideoResizeVertical = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true
    let lastPct = videoHeightPct
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current || !workspaceRef.current) return
      const rect = workspaceRef.current.getBoundingClientRect()
      const pct = ((ev.clientY - rect.top) / rect.height) * 100
      lastPct = Math.min(75, Math.max(20, pct))
      setVideoHeightPct(lastPct)
    }
    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      localStorage.setItem('rh_video_height_pct', String(lastPct))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [videoHeightPct])

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

  const handleCreateCharacter = useCallback(async (name: string): Promise<Character | null> => {
    if (!backendReady) return null
    try {
      const created = await post<Character>('/characters', { title_id: titleId, name })
      setCharacters((prev) => [...prev, created])
      return created
    } catch {
      return null
    }
  }, [backendReady, post, titleId])

  const handleSubLineChange = useCallback(async (idx: number, changes: Partial<SubtitleLine>) => {
    const line = subtitles[idx]
    if (!line) return
    subtitlesUndoStackRef.current.push(subtitles)
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
    subtitlesUndoStackRef.current.push(subtitles)
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
  }, [episodeId, currentTimeMs, backendReady, post, subtitles])

  const handleDeleteSubLine = useCallback(async (id: number) => {
    const line = subtitles.find((l) => l.id === id)
    if (!line) return
    subtitlesUndoStackRef.current.push(subtitles)
    // Filtering by id (not array index) so deleting several lines in one
    // batch — e.g. multi-select + Del — can't drift: each call here is
    // independent of how many others already ran, unlike index-based
    // filtering where every prior removal shifts everyone after it.
    setSubtitles((prev) => prev.filter((l) => l.id !== id))
    if (backendReady) {
      await del(`/subtitle-lines/${id}`).catch(() => {})
    }
  }, [subtitles, backendReady, del])

  const handleDeleteAllSubLines = useCallback(async () => {
    if (subtitles.length === 0) return
    if (!window.confirm(`Видалити всі ${subtitles.length} реплік? Це незворотньо.`)) return
    subtitlesUndoStackRef.current.push(subtitles)
    setSubtitles([])
    if (backendReady) {
      await del(`/episodes/${episodeId}/subtitle-lines`).catch(() => {})
    }
  }, [subtitles, backendReady, del, episodeId])

  const handleUndoSubLines = useCallback(async () => {
    const prev = subtitlesUndoStackRef.current.pop()
    if (!prev) return
    setSubtitles(prev)
    if (backendReady) {
      const payload = prev.map((l) => ({
        start_ms: l.start_ms,
        end_ms: l.end_ms,
        text: l.text,
        character_id: l.character_id,
        ass_style: l.ass_style,
        is_overlap: l.is_overlap,
      }))
      const synced = await put<SubtitleLine[]>(`/episodes/${episodeId}/subtitle-lines`, payload).catch(() => null)
      if (synced) setSubtitles([...synced].sort((a, b) => a.start_ms - b.start_ms))
    }
  }, [backendReady, put, episodeId])

  // Ctrl+V inserts copies of the clipboard lines starting at the current
  // playhead, preserving whatever time gaps existed between them in the
  // original copy so multi-line pastes don't collapse onto one timestamp.
  const handlePasteSubLines = useCallback(async (
    items: Array<Pick<SubtitleLine, 'start_ms' | 'end_ms' | 'text' | 'ass_style' | 'character_id' | 'is_overlap'>>,
    atMs: number
  ) => {
    if (items.length === 0) return
    subtitlesUndoStackRef.current.push(subtitles)
    const baseStart = items[0].start_ms
    const created: SubtitleLine[] = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const newStart = atMs + (it.start_ms - baseStart)
      const body = {
        start_ms: newStart,
        end_ms: newStart + (it.end_ms - it.start_ms),
        text: it.text,
        ass_style: it.ass_style,
        character_id: it.character_id,
        is_overlap: it.is_overlap,
      }
      if (backendReady) {
        const line = await post<SubtitleLine>(`/episodes/${episodeId}/subtitle-lines`, body).catch(
          () => ({ id: Date.now() + i, episode_id: episodeId, ...body }) as SubtitleLine
        )
        created.push(line)
      } else {
        created.push({ id: Date.now() + i, episode_id: episodeId, ...body } as SubtitleLine)
      }
    }
    setSubtitles((prev) => [...prev, ...created].sort((a, b) => a.start_ms - b.start_ms))
  }, [subtitles, backendReady, post, episodeId])

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

  const handleDeleteAllMarkers = useCallback(async () => {
    if (markers.length === 0) return
    if (!window.confirm(`Видалити всі ${markers.length} маркерів? Це незворотньо.`)) return
    setMarkers([])
    if (backendReady) {
      await del(`/episodes/${episodeId}/markers`).catch(() => {})
    }
  }, [markers.length, backendReady, del, episodeId])

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

  function handleAssDragOver(e: React.DragEvent) {
    e.preventDefault()
    setAssDragOver(true)
  }
  function handleAssDragLeave() { setAssDragOver(false) }
  function handleAssDrop(e: React.DragEvent) {
    e.preventDefault()
    setAssDragOver(false)
    if (e.dataTransfer.files.length) handleAssImport(e.dataTransfer.files)
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
  async function handleSeparate(model: SeparationModel, ensemble: boolean, modelFile?: string, params?: SeparationParams) {
    if (!backendReady || !episode?.original_file_path) return
    setSeparating(true)
    setSeparationError(null)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/separate-vocals`, {
        model, ensemble, model_file: modelFile, params,
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
    } catch (err) {
      // Previously swallowed entirely — the "Запустити" button would just
      // stop spinning with zero feedback (e.g. when audio_stem_path isn't
      // ready yet, the backend returns 400 and nothing told the user why).
      console.error('[separate-vocals] request failed:', err)
      setSeparationError(err instanceof Error ? err.message : 'Не вдалося запустити ізоляцію вокалу')
    } finally {
      setSeparating(false)
    }
  }

  async function handleRequestRemotePower(model: SeparationModel, ensemble: boolean, modelFile?: string, params?: SeparationParams) {
    if (!backendReady) return
    setRequestingPower(true)
    setPowerShareError(null)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/request-remote-separation`, {
        model, ensemble, model_file: modelFile, params,
      })
      upsertJob({
        id: result.job_id,
        type: 'request_remote_separation',
        status: 'running',
        percent: 0,
        message: 'Шукаю доступні ПК онлайн…',
        episode_id: episodeId,
      })
      setShowSeparationPanel(false)
    } catch (err) {
      setPowerShareError(err instanceof Error ? err.message : 'Не вдалося надіслати запит')
    } finally {
      setRequestingPower(false)
    }
  }

  // Batch render — runs all 5 methods, each kept as its own separate file
  // (see backend/services/separator_service.py's separate_file_batch).
  // Asks where to save first (native folder dialog), same pattern as
  // handleRender above — cancelling the dialog aborts the batch run
  // entirely rather than silently falling back to the internal data dir.
  async function handleBatchSeparate() {
    if (!backendReady || !episode?.original_file_path) return
    let outputDir: string | null = null
    if (window.electronAPI?.openDirectory) {
      outputDir = await window.electronAPI.openDirectory()
      if (!outputDir) return
    }
    setBatchRendering(true)
    setSeparationError(null)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/batch-separate-vocals`, {
        output_dir: outputDir,
      })
      upsertJob({
        id: result.job_id,
        type: 'batch_separate_vocals',
        status: 'running',
        percent: 0,
        message: 'Пакетний рендер (усі методи)…',
        episode_id: episodeId,
      })
      setShowSeparationPanel(false)
    } catch (err) {
      console.error('[batch-separate-vocals] request failed:', err)
      setSeparationError(err instanceof Error ? err.message : 'Не вдалося запустити пакетний рендер')
    } finally {
      setBatchRendering(false)
    }
  }

  async function handleUseBatchResult(jobId: string, path: string) {
    setUsingBatchResult(path)
    try {
      await post(`/episodes/${episodeId}/use-batch-result`, { job_id: jobId, path })
      setBatchResults(null)
      const ep = await get<Episode>(`/episodes/${episodeId}`)
      setEpisode(ep)
    } catch (err) {
      console.error('[use-batch-result] failed:', err)
      setSeparationError(err instanceof Error ? err.message : 'Не вдалося обрати цей файл')
    } finally {
      setUsingBatchResult(null)
    }
  }

  // Distributed processing — splits the episode across every available
  // Power Share peer + this machine, falling back to plain local separation
  // if nobody's around (see backend/services/distributed_separation_service.py).
  async function handleDistributedSeparate(model: SeparationModel, ensemble: boolean, modelFile?: string, params?: SeparationParams) {
    if (!backendReady || !episode?.original_file_path) return
    setDistributedRunning(true)
    setSeparationError(null)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/distributed-separate-vocals`, {
        model, ensemble, model_file: modelFile, params,
      })
      upsertJob({
        id: result.job_id,
        type: 'distributed_separate_vocals',
        status: 'running',
        percent: 0,
        message: 'Розподілена обробка…',
        episode_id: episodeId,
      })
      setShowSeparationPanel(false)
    } catch (err) {
      console.error('[distributed-separate-vocals] request failed:', err)
      setSeparationError(err instanceof Error ? err.message : 'Не вдалося запустити розподілену обробку')
    } finally {
      setDistributedRunning(false)
    }
  }

  // Detect markers
  async function handleDetectMarkers() {
    if (!backendReady) return
    setMarkersError(null)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/detect-markers`, {})
      upsertJob({
        id: result.job_id,
        type: 'detect_markers',
        status: 'running',
        percent: 0,
        message: 'Виявлення маркерів…',
        episode_id: episodeId,
      })
    } catch (err) {
      // Previously silently swallowed (.catch(() => null)) — a rejection
      // here (e.g. no vocal-only stem, see detect_markers below) produced
      // literally no feedback: button click, nothing happens, no spinner,
      // no error. Surfacing it the same way separationError does elsewhere.
      console.error('[detect-markers] request failed:', err)
      setMarkersError(err instanceof Error ? err.message : 'Не вдалося запустити виявлення маркерів')
    }
  }

  // Export Reaper CSV
  async function handleExportReaper() {
    if (!backendReady) return
    const url = `http://localhost:${backendPort}/api/episodes/${episodeId}/export-reaper-csv`
    window.open(url, '_blank')
  }

  // Final render: mux the episode's own instrumental (vocal already removed
  // by separation) against the original video — asks where to save first
  // (native folder dialog), then renders there; falls back to the episode's
  // own data-dir folder if the dialog isn't available (dev/non-Electron) or
  // the user just confirms without picking a different one isn't offered —
  // cancelling the dialog aborts the render entirely rather than silently
  // falling back, so a cancel reads as "changed my mind", not "render here".
  async function handleRender() {
    if (!backendReady) return
    let outputDir: string | null = null
    if (window.electronAPI?.openDirectory) {
      outputDir = await window.electronAPI.openDirectory()
      if (!outputDir) return
    }
    setRendering(true)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/mux-audio`, {
        output_dir: outputDir,
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

  // Same as handleRender, but the final ffmpeg mux itself runs on a peer:
  // sends the original video AND the instrumental (converted to FLAC first
  // on the backend, to shrink the upload) instead of doing it locally.
  async function handleRequestRemoteRender() {
    if (!backendReady) return
    let outputDir: string | null = null
    if (window.electronAPI?.openDirectory) {
      outputDir = await window.electronAPI.openDirectory()
      if (!outputDir) return
    }
    setRequestingRender(true)
    setRenderError(null)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/request-remote-render`, {
        output_dir: outputDir,
      })
      upsertJob({
        id: result.job_id,
        type: 'request_remote_render',
        status: 'running',
        percent: 0,
        message: 'Шукаю доступні ПК онлайн…',
        episode_id: episodeId,
      })
    } catch (err) {
      console.error('[request-remote-render] request failed:', err)
      setRenderError(err instanceof Error ? err.message : 'Не вдалося надіслати запит на рендер')
    } finally {
      setRequestingRender(false)
    }
  }

  const episodeJob = [...activeJobs.values()].find(
    (j) => j.episode_id === episodeId && j.status === 'running'
  )

  const vocalIsolated = episode?.status === 'vocal_isolated' || episode?.status === 'marked' || episode?.status === 'ready'

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
          <span className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full text-xs bg-amber-900/30 text-amber-300">
            <Spinner size={10} />
            {episodeJob.message} {episodeJob.percent > 0 ? `${episodeJob.percent}%` : ''}
            <button
              onClick={() => del(`/jobs/${episodeJob.id}`).catch(() => {})}
              title="Скасувати"
              className="w-4 h-4 rounded-full flex items-center justify-center text-amber-300/70 hover:text-white hover:bg-amber-400/20 leading-none"
            >
              ✕
            </button>
          </span>
        )}

        {markersError && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-red-900/30 text-red-300 max-w-[420px]">
            <span className="truncate">{markersError}</span>
            <button
              onClick={() => setMarkersError(null)}
              className="w-4 h-4 rounded-full flex items-center justify-center text-red-300/70 hover:text-white hover:bg-red-400/20 leading-none flex-shrink-0"
            >
              ✕
            </button>
          </span>
        )}

        {renderError && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-red-900/30 text-red-300 max-w-[420px]">
            <span className="truncate">{renderError}</span>
            <button
              onClick={() => setRenderError(null)}
              className="w-4 h-4 rounded-full flex items-center justify-center text-red-300/70 hover:text-white hover:bg-red-400/20 leading-none flex-shrink-0"
            >
              ✕
            </button>
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

          {!vocalIsolated && (
            <span className="text-xs text-rh-muted">Виконайте відокремлення вокалу, щоб рендерити</span>
          )}
          {powerShareEnabled && (
            <button
              onClick={handleRequestRemoteRender}
              disabled={!vocalIsolated || requestingRender || rendering}
              className="rh-btn-outline text-xs"
              title="Надіслати відео та інструментал (FLAC) на потужніший ПК для фінального рендеру"
            >
              {requestingRender ? <Spinner size={12} /> : null}
              Запросити потужність
            </button>
          )}
          <button
            onClick={handleRender}
            disabled={!vocalIsolated || rendering || requestingRender}
            className={`text-xs font-bold rounded-lg px-4 py-2 transition-all
              ${vocalIsolated
                ? 'bg-rh-accent text-white hover:bg-[#F03238] hover:shadow-[0_0_20px_rgba(229,33,40,0.3)]'
                : 'bg-rh-border text-rh-muted cursor-not-allowed'
              }`}
          >
            {rendering ? <Spinner size={12} /> : null}
            Рендерити фінальну доріжку
          </button>
        </div>
      </div>

      {/* Separation settings modal */}
      {showSeparationPanel && (
        <VocalSeparationModal
          onClose={() => setShowSeparationPanel(false)}
          onRun={handleSeparate}
          onRequestPower={handleRequestRemotePower}
          onRunBatch={handleBatchSeparate}
          onRunDistributed={handleDistributedSeparate}
          separating={separating}
          requestingPower={requestingPower}
          batchRendering={batchRendering}
          distributedRunning={distributedRunning}
          powerShareEnabled={powerShareEnabled}
          powerShareError={powerShareError}
          separationError={separationError}
          disabled={!episode?.original_file_path}
        />
      )}

      {/* Batch separation results — pick one to become the episode's actual
          instrumental. Batch mode intentionally never sets this on its own
          (see separator_service.separate_file_batch's docstring), so
          without this picker "Рендерити фінальну доріжку" stays disabled
          forever after a batch run even though usable output files exist. */}
      {batchResults && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setBatchResults(null)}>
          <div className="rh-card w-[420px] p-5 flex flex-col gap-3 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Пакетний рендер готовий — обрати результат</h2>
              <button onClick={() => setBatchResults(null)} className="text-rh-muted hover:text-white text-lg leading-none px-1">✕</button>
            </div>
            <p className="text-xs text-rh-muted">
              Кожна модель дала окремий файл у теці, яка щойно відкрилась. Оберіть той, що звучить найкраще —
              він стане інструменталом цієї серії для рендеру.
            </p>
            <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto pr-1">
              {batchResults.items.map((r) => (
                <div key={r.model} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-rh-border">
                  <span className="text-xs font-medium">{r.model}</span>
                  <button
                    onClick={() => handleUseBatchResult(batchResults.jobId, r.path)}
                    disabled={usingBatchResult === r.path}
                    className="rh-btn-outline text-[11px] px-2.5 py-1"
                  >
                    {usingBatchResult === r.path ? <Spinner size={11} /> : 'Обрати'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Main workspace */}
      <div ref={workspaceRef} className="flex-1 flex flex-col overflow-hidden">
        {/* Top: video + waveform — width split between them is resizable */}
        <div ref={topRowRef} className="flex p-2 flex-shrink-0" style={{ height: `${videoHeightPct}%` }}>
          {/* Video player */}
          <div style={{ width: `${videoWidthPct}%` }} className="min-w-0">
            <VideoPlayer
              ref={videoRef}
              src={episode?.original_file_path ?? null}
              vocalStemPath={episode?.vocal_stem_path ?? null}
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

        {/* Drag handle — resize video/waveform panel height */}
        <div
          onMouseDown={startVideoResizeVertical}
          className="h-2 flex-shrink-0 cursor-row-resize group flex items-center justify-center"
          title="Перетягніть, щоб змінити висоту відео"
        >
          <div className="h-1 w-8 rounded-full bg-rh-border group-hover:bg-rh-accent transition-colors" />
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
          <div
            className="flex-1 overflow-hidden relative"
            onDragOver={activeTab === 'subtitles' ? handleAssDragOver : undefined}
            onDragLeave={activeTab === 'subtitles' ? handleAssDragLeave : undefined}
            onDrop={activeTab === 'subtitles' ? handleAssDrop : undefined}
          >
            {assDragOver && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-rh-bg/90 border-2 border-dashed border-rh-accent pointer-events-none">
                <span className="text-sm font-semibold text-rh-accent">Відпустіть, щоб імпортувати ASS-файл</span>
              </div>
            )}
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
                onDeleteAll={handleDeleteAllSubLines}
                onUndo={handleUndoSubLines}
                onPasteLines={handlePasteSubLines}
                onCreateCharacter={handleCreateCharacter}
              />
            ) : (
              <MarkersTab
                markers={markers}
                characters={characters}
                currentTimeMs={currentTimeMs}
                onConfirm={handleMarkerConfirm}
                onEdit={handleMarkerEdit}
                onDelete={handleMarkerDelete}
                onDeleteAll={handleDeleteAllMarkers}
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
