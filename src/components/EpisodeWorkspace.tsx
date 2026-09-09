import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { useBackdropClose } from '../hooks/useBackdropClose'
import { VideoPlayer, type VideoPlayerHandle } from './workspace/VideoPlayer'
import { WaveformViewer } from './workspace/WaveformViewer'
import { SubtitleGrid } from './workspace/SubtitleGrid'
import { SubtitleEditBox } from './workspace/SubtitleEditBox'
import { MarkersTab } from './workspace/MarkersTab'
import { Spinner } from './ui/Spinner'
import { VocalSeparationModal, type SeparationModel, type SeparationParams } from './VocalSeparationModal'
import type { ActorAudioSubmission, Episode, SubtitleLine, Marker, Character, Dubber, JobStatus, Title, TeamActor } from '../types'
import { playRaccoonChirp } from '../utils/notificationSound'

// 'audio' only ever appears once there's at least one actor audio
// submission for this episode — see the audioSubmissions fetch below.
type WorkspaceTab = 'subtitles' | 'markers' | 'audio'

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
  const sharedContentUpdatedAt = useAppStore((s) => s.sharedContentUpdatedAt)

  const [episode, setEpisode] = useState<Episode | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([])
  const [markers, setMarkers] = useState<Marker[]>([])
  const [audioSubmissions, setAudioSubmissions] = useState<ActorAudioSubmission[]>([])
  const [audioFixDrafts, setAudioFixDrafts] = useState<Record<number, string>>({})
  const [audioFixMarkerFilePaths, setAudioFixMarkerFilePaths] = useState<Record<number, string>>({})
  const [audioActionResult, setAudioActionResult] = useState<string | null>(null)
  const audioFixMarkerInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const [characters, setCharacters] = useState<Character[]>([])
  const [teamActors, setTeamActors] = useState<TeamActor[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('subtitles')
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [duration, setDuration] = useState(0)
  const subtitlesUndoStackRef = useRef<SubtitleLine[][]>([])
  const subtitlesRedoStackRef = useRef<SubtitleLine[][]>([])

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
  const batchResultsBackdrop = useBackdropClose(() => setBatchResults(null))
  const [usingBatchResult, setUsingBatchResult] = useState<string | null>(null)
  const [distributedRunning, setDistributedRunning] = useState(false)

  // "Історія ізоляцій" — every past isolation result for this episode,
  // archived automatically instead of silently overwritten each time a new
  // run (or a batch-result pick) replaces the current instrumental (see
  // backend's separator_service._archive_previous_isolation). Auto-deleted
  // after 48h, so this is a short working-memory window, not a full archive.
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [historyItems, setHistoryItems] = useState<{ filename: string; path: string; model: string; created_at: string }[] | null>(null)
  const [restoringHistory, setRestoringHistory] = useState<string | null>(null)
  const [savingHistory, setSavingHistory] = useState<string | null>(null)
  const [savedHistoryFlash, setSavedHistoryFlash] = useState<string | null>(null)
  const historyBackdrop = useBackdropClose(() => setShowHistoryModal(false))

  function openHistoryModal() {
    setShowHistoryModal(true)
    setHistoryItems(null)
    get<{ filename: string; path: string; model: string; created_at: string }[]>(`/episodes/${episodeId}/separation-history`)
      .then(setHistoryItems)
      .catch(() => setHistoryItems([]))
  }

  // Copies an isolation result (from history, or the current active stem)
  // out of the app's own internal stems folder to wherever the user picks
  // — see electron/main.ts's fs:saveFileToChosenFolder.
  async function saveIsolationToFolder(sourcePath: string, key: string) {
    if (!window.electronAPI?.saveFileToChosenFolder) return
    setSavingHistory(key)
    try {
      const saved = await window.electronAPI.saveFileToChosenFolder(sourcePath)
      if (saved) {
        setSavedHistoryFlash(key)
        setTimeout(() => setSavedHistoryFlash((k) => (k === key ? null : k)), 2000)
      }
    } finally {
      setSavingHistory(null)
    }
  }

  async function restoreHistoryItem(filename: string) {
    setRestoringHistory(filename)
    try {
      await post(`/episodes/${episodeId}/separation-history/restore`, { filename })
      const fresh = await get<Episode>(`/episodes/${episodeId}`)
      setEpisode(fresh)
      setShowHistoryModal(false)
    } catch (err) {
      setSeparationError(err instanceof Error ? err.message : 'Не вдалося відновити цю ізоляцію')
    } finally {
      setRestoringHistory(null)
    }
  }

  // "Take a model, separate the vocal, then split THAT into male/female"
  // (backend: run_mvsep_male_female_split) — MVSep-only, needs credits, so
  // gated the same way VocalSeparationModal gates the rest of MVSep: hidden
  // unless eligible AND re-checked server-side on the actual request.
  const [mvsepEligibleForSplit, setMvsepEligibleForSplit] = useState(false)
  const [mvsepSplitBusy, setMvsepSplitBusy] = useState(false)
  const [mvsepSplitError, setMvsepSplitError] = useState<string | null>(null)
  useEffect(() => {
    get<{ eligible: boolean }>('/teams/mvsep-eligible').then((r) => setMvsepEligibleForSplit(r.eligible)).catch(() => {})
  }, [get])

  // Final render/mux
  const [rendering, setRendering] = useState(false)
  const [requestingRender, setRequestingRender] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)

  // ASS import
  const assInputRef = useRef<HTMLInputElement>(null)
  const [importingAss, setImportingAss] = useState(false)
  const [assDragOver, setAssDragOver] = useState(false)
  const [markersDragOver, setMarkersDragOver] = useState(false)
  // Reaper's native marker CSV export writes Bar.Beat.Fraction positions,
  // not a timecode — converting to seconds needs the project's actual
  // tempo, which the CSV never carries (see routers/markers.py's
  // _time_to_seconds). Defaults to Reaper's own new-project default;
  // shared between the "Імпорт CSV" button and drag-drop below, both of
  // which feed the same import call.
  const [markersImportBpm, setMarkersImportBpm] = useState(120)

  const videoRef = useRef<VideoPlayerHandle>(null)

  // Shared episode's original video sits in R2 until someone actually asks
  // for it (see sync_service.download_episode_video's own comment) — this
  // pulls it on demand. Mirrors DirectorWorkspace.tsx/TranslatorWorkspace.tsx's
  // identical banner; this generic workspace is what звукорежисер/клінапер
  // (no dedicated workspace of their own) actually land on, so they need it
  // here too.
  const [downloadingOriginal, setDownloadingOriginal] = useState(false)
  async function handleDownloadOriginal() {
    if (!backendReady || downloadingOriginal) return
    setDownloadingOriginal(true)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/download-original-video`, {})
      upsertJob({
        id: result.job_id, type: 'download_original_video', status: 'running', percent: 0,
        message: 'Завантажую оригінал з хмари…', episode_id: episodeId,
      })
    } catch {
      /* ignore — same best-effort posture as other job triggers here */
    } finally {
      setDownloadingOriginal(false)
    }
  }
  const downloadingOriginalJob = [...activeJobs.values()].find(
    (j) => j.episode_id === episodeId && j.type === 'download_original_video' && j.status === 'running'
  )

  // The клінапер's result, once the director's reviewed and forwarded it
  // (see Episode.cleaned_video_sent_to_sound_engineer_at) — gated the same
  // way as DirectorWorkspace's own download button, but that gate is what
  // makes this button show up here AT ALL (see the JSX below: hidden
  // entirely until sent, not just disabled).
  const [downloadingCleanedVideo, setDownloadingCleanedVideo] = useState(false)
  const [cleanedVideoError, setCleanedVideoError] = useState<string | null>(null)
  async function handleDownloadCleanedVideo() {
    if (downloadingCleanedVideo) return
    setDownloadingCleanedVideo(true)
    try {
      const result = await get<{ url: string }>(`/episodes/${episodeId}/cleaned-video-url`)
      window.open(result.url, '_blank')
    } catch {
      setCleanedVideoError('Не вдалося отримати посилання на очищене відео')
    } finally {
      setDownloadingCleanedVideo(false)
    }
  }

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

  // АКТОР dropdown source — same team-actor lookup as Translator/Director
  // workspaces (see SubtitleGrid/SubtitleEditBox's teamActors prop).
  useEffect(() => {
    if (!backendReady) return
    get<Title>(`/titles/${titleId}`)
      .then((title) => (title.team_id ? get<TeamActor[]>(`/teams/${title.team_id}/actors`) : []))
      .then(setTeamActors)
      .catch(() => setTeamActors([]))
  }, [backendReady, titleId, get])

  // "Звукові доріжки" tab — only shown at all once an actor has "Здати"-ed
  // at least one recording (see ActorWorkspace.tsx's own upload UI).
  const loadAudioSubmissions = useCallback(() => {
    if (!backendReady) return
    get<ActorAudioSubmission[]>(`/episodes/${episodeId}/actor-audio`).then(setAudioSubmissions).catch(() => {})
  }, [backendReady, episodeId, get])
  useEffect(() => { loadAudioSubmissions() }, [loadAudioSubmissions])

  // Sound engineer's own fix-request UI — same shape as DirectorWorkspace's
  // "Звук" tab (see request_actor_audio_fix/import_fix_markers), brought to
  // parity here since this generic workspace previously had only a bare
  // download button and nowhere to send feedback back to the actor.
  // ONE combined "Відправити" — see DirectorWorkspace's identical
  // handleRequestFix for why text and a staged marker CSV both go out
  // together in a single request-fix call instead of two separate ones.
  async function handleAudioRequestFix(submissionId: number) {
    const message = (audioFixDrafts[submissionId] ?? '').trim()
    const markerFilePath = audioFixMarkerFilePaths[submissionId]
    if (!message && !markerFilePath) return
    try {
      await post(`/episodes/${episodeId}/actor-audio/${submissionId}/request-fix`, {
        message, from_role: 'sound_engineer', marker_file_path: markerFilePath, bpm: markersImportBpm,
      })
      setAudioFixDrafts((prev) => ({ ...prev, [submissionId]: '' }))
      setAudioFixMarkerFilePaths((prev) => { const next = { ...prev }; delete next[submissionId]; return next })
      setAudioActionResult('Правки надіслано актору')
      loadAudioSubmissions()
    } catch {
      setAudioActionResult('Не вдалося надіслати правки')
    }
  }
  // Re-check when a teammate's submission was just pulled in via sync (see
  // sync_service.py's push_actor_audio_submission) — otherwise a new
  // submission from an actor on another device only appeared after
  // leaving and re-entering this episode.
  useEffect(() => { if (sharedContentUpdatedAt) loadAudioSubmissions() }, [sharedContentUpdatedAt, loadAudioSubmissions])

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
          } else if (job.type === 'mux_audio' || job.type === 'request_remote_render') {
            setRenderError(job.message || 'Не вдалося відрендерити фінальне відео')
          }
        }
        continue
      }
      if (job.status !== 'complete') continue
      if (handledJobIdsRef.current.has(job.id)) continue
      handledJobIdsRef.current.add(job.id)

      // A separation run can take anywhere from under a minute to well over
      // ten (see the batch/custom-model progress investigation elsewhere
      // this session) — a short sound cue means the user doesn't have to
      // keep glancing back at the tab to notice it finished.
      if (
        job.type === 'separate_vocals' ||
        job.type === 'batch_separate_vocals' ||
        job.type === 'distributed_separate_vocals' ||
        job.type === 'request_remote_separation'
      ) {
        playRaccoonChirp()
      }

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

      // Same "no Episode column to update" situation as batch mode above —
      // neither the male nor the female stem alone IS the episode's vocal,
      // so this just opens the output folder rather than touching anything.
      if (job.type === 'mvsep_male_female') {
        const outputDir = job.result?.output_dir
        if (typeof outputDir === 'string' && window.electronAPI?.openPath) {
          window.electronAPI.openPath(outputDir).catch((err) => console.error('[mvsep-male-female] failed to open output folder:', err))
        }
        continue
      }

      // A multistem MVSep model (e.g. "BS Roformer SW (vocals, bass, drums,
      // guitar, piano, other)") only has room for ONE instrumental in
      // Episode.vocal_stem_path (it's the sum of every non-vocal stem — see
      // mvsep_service.run_separation) — but every individual stem is still
      // downloaded and kept on disk (extra_stems), so a normal single run
      // opens their folder too instead of silently discarding the rest.
      const extraStems = job.result?.extra_stems
      if (job.type === 'separate_vocals' && extraStems && typeof extraStems === 'object' && Object.keys(extraStems).length > 0) {
        const anyPath = Object.values(extraStems as Record<string, string>)[0]
        const dir = anyPath.slice(0, Math.max(anyPath.lastIndexOf('/'), anyPath.lastIndexOf('\\')))
        if (dir && window.electronAPI?.openPath) {
          window.electronAPI.openPath(dir).catch((err) => console.error('[separate-vocals] failed to open stems folder:', err))
        }
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

  // Sync active subtitle to playhead. Overlapping lines (sign/overlay text
  // sharing a time range with dialogue — see SubtitleLine.is_overlap) are
  // normal in this data model, so more than one line can satisfy the time
  // check at once; a plain findIndex always picks the first (topmost) one.
  // That silently overrode an explicit row click: handleSubLineClick seeks
  // the video to the clicked line's start_ms, which re-fires this effect,
  // and if an earlier overlapping line also covers that timestamp the
  // selection snapped back up to it — looked exactly like "clicking a lower
  // row doesn't select it and scrolls back to the top" (confirmed live).
  // Keeping the already-active line active as long as the playhead is still
  // within ITS OWN range fixes that without changing natural forward-
  // playback behavior (a genuinely new range still searches fresh below).
  useEffect(() => {
    if (!subtitles.length) return
    setActiveSubIndex((prev) => {
      if (prev != null) {
        const current = subtitles[prev]
        if (current && currentTimeMs >= current.start_ms && currentTimeMs <= current.end_ms) {
          return prev
        }
      }
      const idx = subtitles.findIndex(
        (s) => currentTimeMs >= s.start_ms && currentTimeMs <= s.end_ms
      )
      return idx >= 0 ? idx : null
    })
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

  const handlePickTeamActor = useCallback(async (deviceId: string, displayName: string): Promise<Character | null> => {
    if (!backendReady) return null
    try {
      const created = await post<Character>('/characters', { title_id: titleId, name: displayName, team_device_id: deviceId })
      setCharacters((prev) => (prev.some((c) => c.id === created.id) ? prev : [...prev, created]))
      return created
    } catch {
      return null
    }
  }, [backendReady, post, titleId])

  // Any fresh edit invalidates whatever "future" redo would have restored —
  // standard undo/redo semantics, same as every text editor.
  const pushUndo = useCallback((snapshot: SubtitleLine[]) => {
    subtitlesUndoStackRef.current.push(snapshot)
    subtitlesRedoStackRef.current = []
  }, [])

  const handleSubLineChange = useCallback(async (idx: number, changes: Partial<SubtitleLine>) => {
    const line = subtitles[idx]
    if (!line) return
    pushUndo(subtitles)
    const updated = { ...line, ...changes }
    setSubtitles((prev) => {
      const next = [...prev]
      next[idx] = updated
      return next
    })
    if (backendReady) {
      await put(`/subtitle-lines/${line.id}`, changes).catch(() => {})
    }
  }, [subtitles, backendReady, put, pushUndo])

  const handleAddSubLine = useCallback(async () => {
    pushUndo(subtitles)
    const newLine: SubtitleLine = {
      id: Date.now(),
      episode_id: episodeId,
      start_ms: currentTimeMs,
      end_ms: currentTimeMs + 3000,
      text: '',
      character_id: null,
      ass_style: 'Default',
      is_overlap: false,
      layer: 0,
      margin_l: 0,
      margin_r: 0,
      margin_v: 0,
    }
    let created = newLine
    if (backendReady) {
      created = await post<SubtitleLine>(`/episodes/${episodeId}/subtitle-lines`, {
        start_ms: newLine.start_ms,
        end_ms: newLine.end_ms,
        text: '',
        ass_style: 'Default',
      }).catch(() => newLine)
    }
    // Select the line this just created — "always have a line to type
    // into" (see SubtitleEditBox's Enter-to-advance, which relies on this
    // for the "advance past the last line" case). start_ms is set to
    // currentTimeMs above, so the playhead-sync effect's own independent
    // search converges on the same index regardless of timing — no race
    // with that effect the way selecting an unrelated existing line could.
    setSubtitles((prev) => {
      const next = [...prev, created].sort((a, b) => a.start_ms - b.start_ms)
      setActiveSubIndex(next.findIndex((l) => l.id === created.id))
      return next
    })
    return created
  }, [episodeId, currentTimeMs, backendReady, post, subtitles, pushUndo])

  // SubtitleEditBox's Enter key: commit (handled by the box itself via
  // onCommitText) then move on — to the next existing line if there is
  // one, otherwise create a fresh one to keep typing into.
  const handleEditBoxCommitText = useCallback((id: number, text: string) => {
    const idx = subtitles.findIndex((l) => l.id === id)
    if (idx >= 0) handleSubLineChange(idx, { text })
  }, [subtitles, handleSubLineChange])

  // Toolbar fields (style/actor/layer/margins/timing) — same id-to-index
  // translation as handleEditBoxCommitText, generalized to any subset of
  // SubtitleLine's fields instead of just text.
  const handleEditBoxFieldChange = useCallback((id: number, changes: Partial<SubtitleLine>) => {
    const idx = subtitles.findIndex((l) => l.id === id)
    if (idx >= 0) handleSubLineChange(idx, changes)
  }, [subtitles, handleSubLineChange])

  const handleEditBoxAdvance = useCallback(() => {
    if (activeSubIndex == null) return
    const nextIdx = activeSubIndex + 1
    if (nextIdx < subtitles.length) {
      handleSubLineClick(nextIdx)
    } else {
      handleAddSubLine()
    }
  }, [activeSubIndex, subtitles.length, handleSubLineClick, handleAddSubLine])

  const handleEditBoxNavigatePrev = useCallback(() => {
    if (activeSubIndex == null || activeSubIndex <= 0) return
    handleSubLineClick(activeSubIndex - 1)
  }, [activeSubIndex, handleSubLineClick])

  const handleDeleteSubLine = useCallback(async (id: number) => {
    const line = subtitles.find((l) => l.id === id)
    if (!line) return
    pushUndo(subtitles)
    // Filtering by id (not array index) so deleting several lines in one
    // batch — e.g. multi-select + Del — can't drift: each call here is
    // independent of how many others already ran, unlike index-based
    // filtering where every prior removal shifts everyone after it.
    setSubtitles((prev) => prev.filter((l) => l.id !== id))
    if (backendReady) {
      await del(`/subtitle-lines/${id}`).catch(() => {})
    }
  }, [subtitles, backendReady, del, pushUndo])

  const handleDeleteAllSubLines = useCallback(async () => {
    if (subtitles.length === 0) return
    if (!window.confirm(`Видалити всі ${subtitles.length} реплік? Це незворотньо.`)) return
    pushUndo(subtitles)
    setSubtitles([])
    if (backendReady) {
      await del(`/episodes/${episodeId}/subtitle-lines`).catch(() => {})
    }
  }, [subtitles, backendReady, del, episodeId, pushUndo])

  const syncRestoredSubtitles = useCallback(async (snapshot: SubtitleLine[]) => {
    setSubtitles(snapshot)
    if (backendReady) {
      const payload = snapshot.map((l) => ({
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

  const handleUndoSubLines = useCallback(async () => {
    const prev = subtitlesUndoStackRef.current.pop()
    if (!prev) return
    subtitlesRedoStackRef.current.push(subtitles)
    await syncRestoredSubtitles(prev)
  }, [subtitles, syncRestoredSubtitles])

  const handleRedoSubLines = useCallback(async () => {
    const next = subtitlesRedoStackRef.current.pop()
    if (!next) return
    subtitlesUndoStackRef.current.push(subtitles)
    await syncRestoredSubtitles(next)
  }, [subtitles, syncRestoredSubtitles])

  // Ctrl+V inserts copies of the clipboard lines starting at the current
  // playhead, preserving whatever time gaps existed between them in the
  // original copy so multi-line pastes don't collapse onto one timestamp.
  const handlePasteSubLines = useCallback(async (
    items: Array<Pick<SubtitleLine, 'start_ms' | 'end_ms' | 'text' | 'ass_style' | 'character_id' | 'is_overlap'>>,
    atMs: number
  ) => {
    if (items.length === 0) return
    pushUndo(subtitles)
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
  }, [subtitles, backendReady, post, episodeId, pushUndo])

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

  // Bulk-assigns every marker of one color to one actor at once — the
  // "Кольори" legend panel's per-color picker.
  const handleAssignMarkerColor = useCallback(async (color: string, characterId: number | null) => {
    setMarkers((prev) => prev.map((m) => (m.color === color ? { ...m, character_id: characterId } : m)))
    if (backendReady) {
      await put(`/episodes/${episodeId}/markers/by-color`, { color, character_id: characterId }).catch(() => {})
    }
  }, [backendReady, put, episodeId])

  const handleImportMarkers = useCallback(async (file: File, bpm: number) => {
    if (!backendReady) return
    const filePath = (file as File & { path?: string }).path ?? ''
    if (!filePath) return
    try {
      const imported = await post<Marker[]>(`/episodes/${episodeId}/markers/import`, { file_path: filePath, bpm })
      setMarkers(imported)
    } catch {
      /* silent — same posture as ASS import's own drag/drop error handling */
    }
  }, [backendReady, post, episodeId])

  function handleMarkersDragOver(e: React.DragEvent) {
    e.preventDefault()
    setMarkersDragOver(true)
  }
  function handleMarkersDragLeave() { setMarkersDragOver(false) }
  function handleMarkersDrop(e: React.DragEvent) {
    e.preventDefault()
    setMarkersDragOver(false)
    if (e.dataTransfer.files.length) handleImportMarkers(e.dataTransfer.files[0], markersImportBpm)
  }

  // ASS import
  async function handleAssImport(files: FileList) {
    const file = files[0]
    if (!file) return
    // Same as DirectorWorkspace's own handleAssImport (see that file's
    // comment) — always keeps actor assignments, matched server-side by
    // exact timing with a same-line-count positional fallback.
    setImportingAss(true)
    try {
      if (backendReady) {
        const fd = new FormData()
        fd.append('file', file)
        const result = await post<{ job_id: string }>(`/episodes/${episodeId}/import-ass`, {
          file_path: (file as File & { path?: string }).path ?? '', preserve_assignments: true,
        })
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
  // mvsepModels, when passed (VocalSeparationModal's own MVSep batch mode),
  // switches the backend onto run_mvsep_batch_separation instead — each
  // entry there spends real studio credits, unlike the free local batch.
  async function handleBatchSeparate(mvsepModels?: Array<{ label: string; sepType: string; addOpt1: string }>) {
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
        ...(mvsepModels ? { mvsep_models: mvsepModels } : {}),
      })
      upsertJob({
        id: result.job_id,
        type: 'batch_separate_vocals',
        status: 'running',
        percent: 0,
        message: mvsepModels ? 'Пакетний рендер MVSep…' : 'Пакетний рендер (усі методи)…',
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

  // "Take a model, separate the vocal, then split THAT into male/female"
  async function handleMvsepMaleFemale() {
    if (!backendReady || !vocalIsolated) return
    setMvsepSplitError(null)
    setMvsepSplitBusy(true)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/mvsep-male-female`, {})
      upsertJob({
        id: result.job_id,
        type: 'mvsep_male_female',
        status: 'running',
        percent: 0,
        message: 'MVSep: розділення за статтю…',
        episode_id: episodeId,
      })
    } catch (err) {
      console.error('[mvsep-male-female] request failed:', err)
      setMvsepSplitError(err instanceof Error ? err.message : 'Не вдалося запустити розділення за статтю')
    } finally {
      setMvsepSplitBusy(false)
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

  // The sound engineer's own "Звук" tab only deals with tracks the director
  // has actually forwarded (sent_to_sound_engineer_at set) — before that,
  // it's still the director's own review pile (see DirectorWorkspace's
  // "Звук" tab, which has the multi-select "Відправити звукорежисеру"
  // action). Confirmed with the user 2026-09-08: fixes should NOT be
  // writable on a track the sound engineer hasn't actually received yet.
  const forwardedAudioSubmissions = audioSubmissions.filter((s) => s.sent_to_sound_engineer_at)

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

        {mvsepSplitError && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-red-900/30 text-red-300 max-w-[420px]">
            <span className="truncate">{mvsepSplitError}</span>
            <button
              onClick={() => setMvsepSplitError(null)}
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
          {cleanedVideoError && <span className="text-[11px] text-rh-muted">{cleanedVideoError}</span>}
          {/* Клінапер's result, once the director's forwarded it — see
              Episode.cleaned_video_sent_to_sound_engineer_at's own comment.
              Hidden entirely (not just disabled) until then. */}
          {episode?.cleaned_video_sent_to_sound_engineer_at && (
            <button onClick={handleDownloadCleanedVideo} className="rh-btn-outline text-xs" disabled={downloadingCleanedVideo}>
              {downloadingCleanedVideo ? <Spinner size={12} /> : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              )}
              Очищене відео від клінапера
            </button>
          )}
          {/* Import ASS */}
          <button onClick={() => assInputRef.current?.click()} className="rh-btn-outline text-xs" disabled={importingAss}>
            {importingAss ? <Spinner size={12} /> : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            )}
            Імпорт ASS/SRT
          </button>
          <input ref={assInputRef} type="file" accept=".ass,.srt" className="hidden" onChange={(e) => { if (e.target.files) handleAssImport(e.target.files) }} />

          {/* Export SRT (per actor) + one combined full ASS, zipped together — see srt_exporter.py */}
          <button onClick={handleExportSrt} className="rh-btn-outline text-xs" disabled={!backendReady}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Експорт SRT + ASS
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

          {/* Past isolation results — see backend's separation-history endpoints */}
          <button onClick={openHistoryModal} className="rh-btn-outline text-xs" title="Прослухати попередні ізоляції цієї серії (зберігаються 48 годин)">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>
            </svg>
            Історія
          </button>

          {/* Saves the CURRENT active instrumental out of the app's internal
              stems folder to wherever the user picks — same mechanism as the
              per-item button in the Історія modal below. */}
          {episode?.vocal_stem_path && (
            <button
              onClick={() => saveIsolationToFolder(episode.vocal_stem_path!, 'current')}
              disabled={savingHistory === 'current'}
              className="rh-btn-outline text-xs"
              title="Зберегти поточну ізоляцію у вибрану папку на диску"
            >
              {savingHistory === 'current' ? (
                <Spinner size={12} />
              ) : savedHistoryFlash === 'current' ? (
                '✓ Збережено'
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  Завантажити ізоляцію
                </>
              )}
            </button>
          )}

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
          vocalIsolated={vocalIsolated}
          maleFemaleEligible={mvsepEligibleForSplit}
          maleFemaleSplitBusy={mvsepSplitBusy}
          onMaleFemaleSplit={handleMvsepMaleFemale}
        />
      )}

      {/* Batch separation results — pick one to become the episode's actual
          instrumental. Batch mode intentionally never sets this on its own
          (see separator_service.separate_file_batch's docstring), so
          without this picker "Рендерити фінальну доріжку" stays disabled
          forever after a batch run even though usable output files exist. */}
      {batchResults && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" {...batchResultsBackdrop}>
          <div className="rh-card w-[480px] p-5 flex flex-col gap-3 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Пакетний рендер готовий — обрати результат</h2>
              <button onClick={() => setBatchResults(null)} className="text-rh-muted hover:text-white text-lg leading-none px-1">✕</button>
            </div>
            <p className="text-xs text-rh-muted">
              Кожна модель дала окремий файл — прослухайте прямо тут і оберіть той, що звучить найкраще:
              він стане інструменталом цієї серії для рендеру. Ця бібліотека тимчасова — файли
              автоматично видаляються через 48 годин, щоб не займати місце.
            </p>
            <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto pr-1">
              {batchResults.items.map((r) => (
                <div key={r.model} className="flex flex-col gap-1.5 px-3 py-2 rounded-lg border border-rh-border">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium truncate">{r.model}</span>
                    <button
                      onClick={() => handleUseBatchResult(batchResults.jobId, r.path)}
                      disabled={usingBatchResult === r.path}
                      className="rh-btn-outline text-[11px] px-2.5 py-1 flex-shrink-0"
                    >
                      {usingBatchResult === r.path ? <Spinner size={11} /> : 'Обрати'}
                    </button>
                  </div>
                  <audio
                    controls
                    preload="none"
                    src={`http://localhost:${backendPort}/api/stream?path=${encodeURIComponent(r.path)}`}
                    className="w-full h-8"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showHistoryModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" {...historyBackdrop}>
          <div className="rh-card w-[480px] p-5 flex flex-col gap-3 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Історія ізоляцій</h2>
              <button onClick={() => setShowHistoryModal(false)} className="text-rh-muted hover:text-white text-lg leading-none px-1">✕</button>
            </div>
            <p className="text-xs text-rh-muted">
              Щоразу, коли нова ізоляція (чи вибір результату пакетного рендеру) заміняє поточний
              інструментал, попередній автоматично потрапляє сюди — прослухайте й за потреби поверніть.
              Зберігається 48 годин, потім видаляється автоматично.
            </p>
            {historyItems === null && (
              <div className="flex justify-center py-6"><Spinner size={18} className="text-rh-accent" /></div>
            )}
            {historyItems?.length === 0 && (
              <p className="text-xs text-rh-muted text-center py-4">Ще немає попередніх ізоляцій цієї серії.</p>
            )}
            {historyItems && historyItems.length > 0 && (
              <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto pr-1">
                {historyItems.map((item) => (
                  <div key={item.filename} className="flex flex-col gap-1.5 px-3 py-2 rounded-lg border border-rh-border">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">{item.model}</div>
                        <div className="text-[10.5px] text-rh-muted">{new Date(item.created_at).toLocaleString()}</div>
                      </div>
                      <button
                        onClick={() => saveIsolationToFolder(item.path, item.filename)}
                        disabled={savingHistory === item.filename}
                        className="rh-btn-outline text-[11px] px-2.5 py-1 flex-shrink-0"
                        title="Зберегти файл у вибрану папку на диску"
                      >
                        {savingHistory === item.filename ? <Spinner size={11} /> : savedHistoryFlash === item.filename ? '✓ Збережено' : 'Завантажити'}
                      </button>
                      <button
                        onClick={() => restoreHistoryItem(item.filename)}
                        disabled={restoringHistory === item.filename}
                        className="rh-btn-outline text-[11px] px-2.5 py-1 flex-shrink-0"
                      >
                        {restoringHistory === item.filename ? <Spinner size={11} /> : 'Використати'}
                      </button>
                    </div>
                    <audio
                      controls
                      preload="none"
                      src={`http://localhost:${backendPort}/api/stream?path=${encodeURIComponent(item.path)}`}
                      className="w-full h-8"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main workspace */}
      <div ref={workspaceRef} className="flex-1 flex flex-col overflow-hidden">
        {/* Top: video + waveform — width split between them is resizable */}
        <div ref={topRowRef} className="flex p-2 flex-shrink-0" style={{ height: `${videoHeightPct}%` }}>
          {/* Video player */}
          <div style={{ width: `${videoWidthPct}%` }} className="min-w-0 relative">
            {!episode?.original_file_path && episode?.remote_video_transfer_id && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-rh-bg/90 rounded-2xl">
                <span className="text-[11.5px] text-rh-muted px-4 text-center">
                  Оригінальне відео є в хмарі, але ще не завантажене на цей пристрій
                </span>
                <button
                  onClick={handleDownloadOriginal}
                  disabled={!backendReady || downloadingOriginal || !!downloadingOriginalJob}
                  className="rh-btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50"
                >
                  {downloadingOriginalJob ? (
                    <>
                      <Spinner size={12} />
                      {downloadingOriginalJob.percent}%
                    </>
                  ) : 'Завантажити оригінал'}
                </button>
              </div>
            )}
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
              audioPath={episode?.vocal_stem_path ?? null}
              currentTime={currentTimeMs / 1000}
              duration={duration}
              markers={markers}
              onSeek={(t) => videoRef.current?.seek(t)}
              onMarkerClick={(m) => videoRef.current?.seek(m.position_seconds)}
              backendPort={backendPort}
              label="Інструментал (без вокалу)"
              emptyMessage="Виконайте ізоляцію вокалу для відображення форми хвилі"
              lines={subtitles}
              activeIndex={activeSubIndex}
              onLineTimingChange={handleSubLineChange}
              onLineActivate={handleSubLineClick}
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
            {forwardedAudioSubmissions.length > 0 && (
              <TabButton active={activeTab === 'audio'} onClick={() => setActiveTab('audio')}>
                Звукові доріжки
                <span className="ml-1.5 text-rh-muted text-xs">{forwardedAudioSubmissions.length}</span>
              </TabButton>
            )}
          </div>

          {/* Tab content */}
          <div
            className="flex-1 overflow-hidden relative"
            onDragOver={activeTab === 'subtitles' ? handleAssDragOver : activeTab === 'markers' ? handleMarkersDragOver : undefined}
            onDragLeave={activeTab === 'subtitles' ? handleAssDragLeave : activeTab === 'markers' ? handleMarkersDragLeave : undefined}
            onDrop={activeTab === 'subtitles' ? handleAssDrop : activeTab === 'markers' ? handleMarkersDrop : undefined}
          >
            {assDragOver && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-rh-bg/90 border-2 border-dashed border-rh-accent pointer-events-none">
                <span className="text-sm font-semibold text-rh-accent">Відпустіть, щоб імпортувати ASS/SRT-файл</span>
              </div>
            )}
            {markersDragOver && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-rh-bg/90 border-2 border-dashed border-rh-accent pointer-events-none">
                <span className="text-sm font-semibold text-rh-accent">Відпустіть, щоб імпортувати CSV з маркерами</span>
              </div>
            )}
            {activeTab === 'subtitles' ? (
              <div className="flex flex-col h-full overflow-hidden">
                <SubtitleEditBox
                  line={activeSubIndex != null ? subtitles[activeSubIndex] ?? null : null}
                  characters={characters}
                  teamActors={teamActors}
                  styleOptions={Array.from(new Set(subtitles.map((l) => l.ass_style)))}
                  onCommitText={handleEditBoxCommitText}
                  onFieldChange={handleEditBoxFieldChange}
                  onCreateCharacter={handleCreateCharacter}
                  onPickTeamActor={handlePickTeamActor}
                  onAdvance={handleEditBoxAdvance}
                  onNavigatePrev={handleEditBoxNavigatePrev}
                  onUndo={handleUndoSubLines}
                  onRedo={handleRedoSubLines}
                />
                <div className="flex-1 min-h-0">
                  <SubtitleGrid
                    lines={subtitles}
                    characters={characters}
                    teamActors={teamActors}
                    activeIndex={activeSubIndex}
                    currentTimeMs={currentTimeMs}
                    onLineClick={handleSubLineClick}
                    onLineChange={handleSubLineChange}
                    onAddLine={handleAddSubLine}
                    onDeleteLine={handleDeleteSubLine}
                    onDeleteAll={handleDeleteAllSubLines}
                    onUndo={handleUndoSubLines}
                    onRedo={handleRedoSubLines}
                    onPasteLines={handlePasteSubLines}
                    onCreateCharacter={handleCreateCharacter}
                    onPickTeamActor={handlePickTeamActor}
                  />
                </div>
              </div>
            ) : activeTab === 'markers' ? (
              <MarkersTab
                markers={markers}
                characters={characters}
                teamActors={teamActors}
                currentTimeMs={currentTimeMs}
                onConfirm={handleMarkerConfirm}
                onEdit={handleMarkerEdit}
                onDelete={handleMarkerDelete}
                onDeleteAll={handleDeleteAllMarkers}
                onAdd={handleMarkerAdd}
                onSeek={(t) => videoRef.current?.seek(t)}
                onAssignColor={handleAssignMarkerColor}
                onImport={handleImportMarkers}
                importBpm={markersImportBpm}
                onImportBpmChange={setMarkersImportBpm}
                onPickTeamActor={handlePickTeamActor}
              />
            ) : (
              <div className="h-full overflow-y-auto p-4 flex flex-col gap-2">
                {audioActionResult && (
                  <div className="text-[11px] text-rh-accent flex items-center gap-2">
                    {audioActionResult}
                    <button onClick={() => setAudioActionResult(null)} className="text-rh-muted hover:text-white">✕</button>
                  </div>
                )}
                {forwardedAudioSubmissions.map((s) => {
                  const original = s.fix_of_submission_id
                    ? audioSubmissions.find((o) => o.id === s.fix_of_submission_id)
                    : null
                  return (
                  <div key={s.id} className="bg-rh-card border border-rh-border rounded-2xl px-4 py-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-bold truncate">
                          {s.fix_of_submission_id && <span className="mr-1" title="Виправлення">🔧</span>}
                          {s.filename}
                        </div>
                        <div className="text-[10.5px] text-rh-muted mt-0.5">
                          {s.character_name ?? '—'} · {s.uploaded_by_name} · {new Date(s.created_at).toLocaleString()}
                          {original && ` · виправлення до «${original.filename}»`}
                          {s.fix_of_submission_id && (s.accepted_at ? ' · ✓ прийнято режисером' : ' · очікує прийняття режисером')}
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            const result = await get<{ url: string }>(`/episodes/${episodeId}/actor-audio/${s.id}/url`)
                            window.open(result.url, '_blank')
                          } catch {
                            /* ignore — transient signaling hiccup, same posture as the video download button */
                          }
                        }}
                        className="rh-btn-outline text-xs flex-shrink-0"
                      >
                        Завантажити
                      </button>
                    </div>
                    <div className="flex flex-col gap-2">
                      <textarea
                        value={audioFixDrafts[s.id] ?? ''}
                        onChange={(e) => setAudioFixDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        placeholder="Правки для актора…"
                        rows={3}
                        className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px] resize-y"
                      />
                      <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => handleAudioRequestFix(s.id)}
                        disabled={!(audioFixDrafts[s.id] ?? '').trim() && !audioFixMarkerFilePaths[s.id]}
                        className="rh-btn-primary text-[11px] px-2.5 py-1.5 flex-shrink-0 disabled:opacity-40"
                      >
                        Відправити
                      </button>
                      <button
                        onClick={() => audioFixMarkerInputRefs.current[s.id]?.click()}
                        className="rh-btn-outline text-[11px] px-2.5 py-1.5 flex-shrink-0"
                        title="Скачайте доріжку, перевірте в Reaper, експортуйте маркери фіксів і додайте CSV — надішлеться разом з текстом одним натисканням «Відправити»"
                      >
                        {audioFixMarkerFilePaths[s.id]
                          ? `Маркери: ${audioFixMarkerFilePaths[s.id].split(/[\\/]/).pop()}`
                          : `Додати маркери фіксів (.csv)${s.fix_marker_count > 0 ? ` — вже ${s.fix_marker_count}` : ''}`}
                      </button>
                      {audioFixMarkerFilePaths[s.id] && (
                        <button
                          onClick={() => setAudioFixMarkerFilePaths((prev) => { const next = { ...prev }; delete next[s.id]; return next })}
                          className="text-[10.5px] text-rh-muted hover:text-white"
                        >
                          ✕
                        </button>
                      )}
                      <input
                        ref={(el) => { audioFixMarkerInputRefs.current[s.id] = el }}
                        type="file"
                        accept=".csv"
                        className="hidden"
                        onChange={(e) => {
                          const filePath = (e.target.files?.[0] as (File & { path?: string }) | undefined)?.path
                          if (filePath) setAudioFixMarkerFilePaths((prev) => ({ ...prev, [s.id]: filePath }))
                          e.target.value = ''
                        }}
                      />
                      </div>
                    </div>
                    {s.fix_message && (
                      <div className="text-[10.5px] text-rh-muted whitespace-pre-wrap">
                        Останні правки: «{s.fix_message}»
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
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
