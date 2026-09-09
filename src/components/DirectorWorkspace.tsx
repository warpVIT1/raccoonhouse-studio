import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { VideoPlayer, type VideoPlayerHandle } from './workspace/VideoPlayer'
import { WaveformViewer } from './workspace/WaveformViewer'
import { SubtitleGrid } from './workspace/SubtitleGrid'
import { SubtitleEditBox } from './workspace/SubtitleEditBox'
import { MarkersTab } from './workspace/MarkersTab'
import { Spinner } from './ui/Spinner'
import type {
  ActorAudioSubmission, Episode, SubtitleLine, Marker, Character, Dubber, Profile, Title, TeamActor,
} from '../types'

interface DirectorWorkspaceProps {
  episodeId: number
  titleId: number
}

// Who places markers varies by studio — here it's the sound engineer
// (EpisodeWorkspace), but other teams have the director do it (confirmed
// live 2026-08-18), so this tab mirrors EpisodeWorkspace's Markers tab
// verbatim rather than being a role-exclusive surface. 'audio' mirrors
// EpisodeWorkspace's own "Звукові доріжки" tab — the director needing to
// download submitted tracks (not just the sound engineer) was a real gap,
// confirmed live 2026-08-19. (The old 'admin' tab moved out entirely — see
// AdminWorkspace.tsx, now a peer of this workspace in EpisodeRoleRouter
// rather than nested inside it.)
type DirectorTab = 'lines' | 'markers' | 'audio' | 'roles'

function extractApiError(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback
  const match = e.message.match(/\{.*\}$/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (typeof parsed.detail === 'string') return parsed.detail
    } catch {
      /* not JSON — fall through to the raw message */
    }
  }
  return e.message
}

// The "director" role's own workspace — previously just a bare character/
// dubber CRUD page with no video or subtitles at all (the director couldn't
// review or time what the translator produced, only assign names). Now the
// same Aegisub-style editor as TranslatorWorkspace (video + waveform + grid
// + edit box, ported verbatim — that plumbing is role-agnostic), plus a
// "Ролі" tab for the character/dubber assignment this page always had.
export function DirectorWorkspace({ episodeId, titleId }: DirectorWorkspaceProps) {
  const { get, post, put, del } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const backendPort = useAppStore((s) => s.backendPort)
  const activeJobs = useAppStore((s) => s.activeJobs)
  const upsertJob = useAppStore((s) => s.upsertJob)
  const sharedContentUpdatedAt = useAppStore((s) => s.sharedContentUpdatedAt)

  const [episode, setEpisode] = useState<Episode | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([])
  const [markers, setMarkers] = useState<Marker[]>([])
  const [markersDragOver, setMarkersDragOver] = useState(false)
  const [markersImportBpm, setMarkersImportBpm] = useState(120)
  const [audioSubmissions, setAudioSubmissions] = useState<ActorAudioSubmission[]>([])
  const [selectedAudioIds, setSelectedAudioIds] = useState<Set<number>>(new Set())
  const [fixDrafts, setFixDrafts] = useState<Record<number, string>>({})
  const [fixMarkerFilePaths, setFixMarkerFilePaths] = useState<Record<number, string>>({})
  const [audioActionResult, setAudioActionResult] = useState<string | null>(null)
  const fixMarkerInputRefs = useRef<Record<number, HTMLInputElement | null>>({})

  const [characters, setCharacters] = useState<Character[]>([])
  const [teamActors, setTeamActors] = useState<TeamActor[]>([])
  const [dubbers, setDubbers] = useState<Dubber[]>([])
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(false)
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<DirectorTab>('lines')
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [duration, setDuration] = useState(0)
  const subtitlesUndoStackRef = useRef<SubtitleLine[][]>([])
  const subtitlesRedoStackRef = useRef<SubtitleLine[][]>([])
  const videoRef = useRef<VideoPlayerHandle>(null)

  const [newCharName, setNewCharName] = useState('')
  const [newCharCode, setNewCharCode] = useState('')
  const [newDubberName, setNewDubberName] = useState('')

  // Video/waveform split — own localStorage keys, same reasoning as
  // TranslatorWorkspace's (a director's preferred split needn't match
  // either the translator's or the sound-engineer's).
  const [videoWidthPct, setVideoWidthPct] = useState(() => {
    const saved = Number(localStorage.getItem('rh_director_video_width_pct'))
    return saved >= 20 && saved <= 85 ? saved : 38
  })
  const [videoHeightPct, setVideoHeightPct] = useState(() => {
    const saved = Number(localStorage.getItem('rh_director_video_height_pct'))
    return saved >= 20 && saved <= 75 ? saved : 42
  })
  const topRowRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)

  const assInputRef = useRef<HTMLInputElement>(null)
  const [importingAss, setImportingAss] = useState(false)
  const [assDragOver, setAssDragOver] = useState(false)

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

  // Dubbers/profiles are title-scoped (voice cast doesn't vary per episode),
  // loaded separately from the episode-scoped data above.
  const loadRoles = useCallback(async () => {
    try {
      const [chars, dubs, profs] = await Promise.all([
        get<Character[]>(`/characters?title_id=${titleId}`),
        get<Dubber[]>('/dubbers'),
        get<Profile[]>('/profiles'),
      ])
      setCharacters(chars)
      setDubbers(dubs)
      setProfiles(profs)
      setRolesError(null)
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося завантажити дані'))
    }
  }, [get, titleId])

  useEffect(() => { loadRoles() }, [loadRoles])

  // АКТОР dropdown source — same team-actor lookup as TranslatorWorkspace
  // (see SubtitleGrid/SubtitleEditBox's teamActors prop). Unrelated to
  // actorProfiles above, which stays local-profile-based for the separate
  // Character→Dubber "Ролі" tab.
  useEffect(() => {
    if (!backendReady) return
    get<Title>(`/titles/${titleId}`)
      .then((title) => (title.team_id ? get<TeamActor[]>(`/teams/${title.team_id}/actors`) : []))
      .then(setTeamActors)
      .catch(() => setTeamActors([]))
  }, [backendReady, titleId, get])

  // "Звук" tab — download + per-track fix notes + multi-select handoff to
  // the sound engineer (see routers/actor_audio.py). Loaded on mount and
  // re-checked whenever a teammate's submission gets pulled in via sync
  // (see EpisodeWorkspace.tsx's identical pattern for why).
  const loadAudioSubmissions = useCallback(() => {
    if (!backendReady) return
    get<ActorAudioSubmission[]>(`/episodes/${episodeId}/actor-audio`).then(setAudioSubmissions).catch(() => {})
  }, [backendReady, episodeId, get])
  useEffect(() => { loadAudioSubmissions() }, [loadAudioSubmissions])
  useEffect(() => { if (sharedContentUpdatedAt) loadAudioSubmissions() }, [sharedContentUpdatedAt, loadAudioSubmissions])

  function toggleAudioSelect(id: number) {
    setSelectedAudioIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // ONE combined "Відправити" per submission — text and/or a staged marker
  // CSV, both go out together in a single request-fix call so the actor
  // gets exactly one notification, not one per control touched (confirmed
  // live 2026-09-08: picking the marker CSV used to fire its own immediate
  // Telegram message before the director had even finished typing the text
  // note next to it).
  async function handleRequestFix(submissionId: number) {
    const message = (fixDrafts[submissionId] ?? '').trim()
    const markerFilePath = fixMarkerFilePaths[submissionId]
    if (!message && !markerFilePath) return
    try {
      await post(`/episodes/${episodeId}/actor-audio/${submissionId}/request-fix`, {
        message, marker_file_path: markerFilePath, bpm: markersImportBpm,
      })
      setFixDrafts((prev) => ({ ...prev, [submissionId]: '' }))
      setFixMarkerFilePaths((prev) => { const next = { ...prev }; delete next[submissionId]; return next })
      setAudioActionResult('Правки надіслано актору')
      loadAudioSubmissions()
    } catch {
      setAudioActionResult('Не вдалося надіслати правки')
    }
  }

  // The director's sign-off gate on an actor's fix re-take (see backend
  // ActorAudioSubmission.fix_of_submission_id/accepted_at) — a corrected
  // track doesn't reach the sound engineer automatically, only once the
  // director explicitly accepts it here (confirm dialog first, same
  // pattern as every other destructive-ish/one-way action in this file).
  async function handleAcceptFix(submissionId: number, filename: string) {
    if (!window.confirm(`Прийняти виправлену доріжку «${filename}» і надіслати звукорежисеру?`)) return
    try {
      await post(`/episodes/${episodeId}/actor-audio/${submissionId}/accept`, {})
      setAudioActionResult('Доріжку прийнято й надіслано звукорежисеру')
      loadAudioSubmissions()
    } catch {
      setAudioActionResult('Не вдалося прийняти доріжку')
    }
  }

  async function handleSendToSoundEngineer() {
    if (selectedAudioIds.size === 0) return
    try {
      const result = await post<{ sent: boolean }>(`/episodes/${episodeId}/actor-audio/send-to-sound-engineer`, {
        submission_ids: [...selectedAudioIds],
      })
      setAudioActionResult(result.sent ? `Надіслано звукорежисеру (${selectedAudioIds.size})` : 'Звукорежисера не знайдено в команді')
      setSelectedAudioIds(new Set())
    } catch {
      setAudioActionResult('Не вдалося надіслати звукорежисеру')
    }
  }

  const handleTimeUpdate = useCallback((t: number) => {
    setCurrentTimeMs(Math.round(t * 1000))
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
      localStorage.setItem('rh_director_video_width_pct', String(lastPct))
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
      localStorage.setItem('rh_director_video_height_pct', String(lastPct))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [videoHeightPct])

  async function handleExportSrt() {
    if (!backendReady) return
    const url = `http://localhost:${backendPort}/api/episodes/${episodeId}/export-srt`
    window.open(url, '_blank')
  }

  // One stage further than the translator's "Надіслати режисеру" — marks
  // the episode ready for actors and kicks off a background job that burns
  // the current subtitles into a 480p hardsub proxy, uploads it to R2, and
  // (once that upload actually succeeds) best-effort notifies whoever on
  // the team has the actor role via Telegram (see
  // actor_video_service.run_export_actor_video / discovery_service.notify_actors).
  // Unlike the translator's synchronous send-to-director, this returns a
  // job_id immediately — the encode+upload can take a while, tracked below
  // via the same activeJobs/upsertJob machinery as ASS import.
  const [sendingToActors, setSendingToActors] = useState(false)
  const [sendResult, setSendResult] = useState<string | null>(null)
  async function handleSendToActors() {
    if (!backendReady || sendingToActors) return
    setSendingToActors(true)
    setSendResult(null)
    try {
      const result = await post<{ job_id: string; subtitle_stage: string }>(
        `/episodes/${episodeId}/send-to-actors`, {},
      )
      setEpisode((prev) => (prev ? { ...prev, subtitle_stage: result.subtitle_stage } : prev))
      upsertJob({
        id: result.job_id, type: 'export_actor_video', status: 'running', percent: 0,
        message: 'Готую відео для акторів…', episode_id: episodeId,
      })
    } catch {
      setSendResult('Помилка надсилання')
    } finally {
      setSendingToActors(false)
    }
  }

  // Per-character "Тільки цьому актору" — same job/pipeline as the bulk
  // send above (see routers/episodes.py's send-to-actor), just scoped to
  // one character; reuses the shared video without re-encoding when one
  // already exists for this episode (see actor_video_service.py's own
  // comment on that shortcut).
  const [sendingToActorId, setSendingToActorId] = useState<number | null>(null)
  async function handleSendToOneActor(characterId: number) {
    if (!backendReady || sendingToActorId != null) return
    setSendingToActorId(characterId)
    try {
      const result = await post<{ job_id: string }>(
        `/episodes/${episodeId}/send-to-actor`, { character_id: characterId },
      )
      upsertJob({
        id: result.job_id, type: 'export_actor_video', status: 'running', percent: 0,
        message: 'Надсилаю актору…', episode_id: episodeId,
      })
    } catch {
      setRolesError('Не вдалося надіслати актору')
    } finally {
      setSendingToActorId(null)
    }
  }

  async function handleAssImport(files: FileList) {
    const file = files[0]
    if (!file) return
    // Always carries actor assignments forward server-side — matched by
    // exact timing where possible, falling back to line position when the
    // line count didn't change (see subtitle_parser.py's own comment).
    // Used to ask via a confirm() dialog first, but that turned out
    // unreliable in practice (confirmed live 2026-09-09 as a recurring "it
    // didn't offer to keep them" report) and the user's own call was
    // simpler anyway: just always keep everything, the director re-picks
    // whatever's wrong by hand afterward — cheaper than silently losing a
    // whole episode's casting on a routine re-import.
    setImportingAss(true)
    try {
      if (backendReady) {
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

  // Marker handlers — mirrors EpisodeWorkspace's own verbatim (see that
  // file's identical block for the full reasoning), since which role
  // places markers varies by studio.
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

  // Shared episode's original video sits in R2 until someone actually asks
  // for it (see sync_service.download_episode_video's own comment — used
  // to auto-download to every teammate's install regardless of need,
  // wasteful for a multi-GB file). This pulls it on demand.
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

  // The клінапер's finished result (see CleanerWorkspace.tsx's own "Здати
  // очищене відео") — previously had a backend endpoint
  // (GET /episodes/{id}/cleaned-video-url) but no way to actually trigger
  // it from here at all, so the director had no path to the cleaned video
  // once it was uploaded.
  const [downloadingCleanedVideo, setDownloadingCleanedVideo] = useState(false)
  async function handleDownloadCleanedVideo() {
    if (downloadingCleanedVideo) return
    setDownloadingCleanedVideo(true)
    try {
      const result = await get<{ url: string }>(`/episodes/${episodeId}/cleaned-video-url`)
      window.open(result.url, '_blank')
    } catch {
      setAudioActionResult('Не вдалося отримати посилання на очищене відео')
    } finally {
      setDownloadingCleanedVideo(false)
    }
  }

  // The director's explicit review gate (2026-09-09) before the sound
  // engineer's own download button shows up at all — see Episode.
  // cleaned_video_sent_to_sound_engineer_at's own comment.
  const [sendingCleanedVideo, setSendingCleanedVideo] = useState(false)
  async function handleSendCleanedVideoToSoundEngineer() {
    if (sendingCleanedVideo) return
    setSendingCleanedVideo(true)
    try {
      const result = await post<{ notified: boolean | null }>(`/episodes/${episodeId}/cleaned-video/send-to-sound-engineer`, {})
      setAudioActionResult(result.notified ? 'Відправлено звукорежисеру' : 'Звукорежисера не знайдено в команді')
      setEpisode((prev) => prev ? { ...prev, cleaned_video_sent_to_sound_engineer_at: new Date().toISOString() } : prev)
    } catch {
      setAudioActionResult('Не вдалося відправити звукорежисеру')
    } finally {
      setSendingCleanedVideo(false)
    }
  }

  const handledJobIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!backendReady) return
    for (const job of activeJobs.values()) {
      if (job.episode_id !== episodeId) continue
      if (job.type === 'export_actor_video' && job.status === 'error') {
        if (!handledJobIdsRef.current.has(job.id)) {
          handledJobIdsRef.current.add(job.id)
          setSendResult(job.message || 'Помилка створення відео для акторів')
        }
        continue
      }
      if (job.status !== 'complete') continue
      if (handledJobIdsRef.current.has(job.id)) continue
      handledJobIdsRef.current.add(job.id)

      if (job.type === 'download_original_video') {
        get<Episode>(`/episodes/${episodeId}`).then(setEpisode).catch(() => {})
        continue
      }

      if (job.type === 'export_actor_video') {
        const notified = job.result?.notified as number | null | undefined
        const perActor = (job.result?.per_actor_notified as number | null | undefined) ?? 0
        const perActorSuffix = perActor > 0 ? ` · ${perActor} актора(ів) отримали свої репліки окремо` : ''
        if (notified == null) {
          setSendResult(`Надіслано (без сповіщення — немає активної команди)${perActorSuffix}`)
        } else if (notified === 0) {
          setSendResult(`Надіслано, але жоден актор не знайдений у команді${perActorSuffix}`)
        } else {
          setSendResult(`Надіслано, сповіщено ${notified} актора(ів)${perActorSuffix}`)
        }
        get<Episode>(`/episodes/${episodeId}`).then(setEpisode).catch(() => {})
        continue
      }

      get<SubtitleLine[]>(`/episodes/${episodeId}/subtitle-lines`).then(setSubtitles).catch(() => {})
      loadRoles()
    }
  }, [activeJobs, backendReady, episodeId, get, loadRoles])

  useEffect(() => {
    if (!subtitles.length) return
    setActiveSubIndex((prev) => {
      if (prev != null) {
        const current = subtitles[prev]
        if (current && currentTimeMs >= current.start_ms && currentTimeMs <= current.end_ms) {
          return prev
        }
      }
      const idx = subtitles.findIndex((s) => currentTimeMs >= s.start_ms && currentTimeMs <= s.end_ms)
      return idx >= 0 ? idx : null
    })
  }, [currentTimeMs, subtitles])

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
    setSubtitles((prev) => {
      const next = [...prev, created].sort((a, b) => a.start_ms - b.start_ms)
      setActiveSubIndex(next.findIndex((l) => l.id === created.id))
      return next
    })
    return created
  }, [episodeId, currentTimeMs, backendReady, post, subtitles, pushUndo])

  const handleEditBoxCommitText = useCallback((id: number, text: string) => {
    const idx = subtitles.findIndex((l) => l.id === id)
    if (idx >= 0) handleSubLineChange(idx, { text })
  }, [subtitles, handleSubLineChange])

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

  // --- Roles tab: character/dubber CRUD (unchanged from before) plus
  // role-based actor pulling (new — see addDubberFromProfile). ---
  async function addCharacter() {
    if (!newCharName.trim()) return
    try {
      await post('/characters', { title_id: titleId, name: newCharName.trim(), code: newCharCode.trim() || null })
      setNewCharName('')
      setNewCharCode('')
      await loadRoles()
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося додати персонажа'))
    }
  }

  async function removeCharacter(id: number) {
    try {
      await del(`/characters/${id}`)
      await loadRoles()
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося видалити персонажа'))
    }
  }

  async function assignDubber(characterId: number, dubberId: number) {
    try {
      await post('/character-dubber-map', { character_id: characterId, dubber_id: dubberId, title_id: titleId })
      await loadRoles()
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося призначити дабера'))
    }
  }

  // Assigns a REAL team actor directly (Character.team_device_id) instead
  // of the local-profile-only Dubber system above — the same field the
  // subtitle grid's own АКТОР dropdown sets, so an actor who already
  // picked themselves there shows up pre-selected here too. See
  // routers/characters.py's PUT /characters/{id}/team-actor.
  async function assignTeamActor(characterId: number, deviceId: string | null) {
    try {
      const updated = await put<Character>(`/characters/${characterId}/team-actor`, { team_device_id: deviceId })
      setCharacters((prev) => prev.map((c) => (c.id === characterId ? updated : c)))
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося призначити актора'))
    }
  }

  async function addDubber() {
    if (!newDubberName.trim()) return
    try {
      await post('/dubbers', { name: newDubberName.trim() })
      setNewDubberName('')
      await loadRoles()
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося додати дабера'))
    }
  }

  // One-click "this local profile already has the actor role — make them a
  // dubber" instead of retyping their name and separately picking them from
  // a profile dropdown that doesn't distinguish actors from anyone else.
  async function addDubberFromProfile(profile: Profile) {
    try {
      await post('/dubbers', { name: profile.name, profile_id: profile.id })
      await loadRoles()
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося додати дабера'))
    }
  }

  async function linkDubberProfile(dubber: Dubber, profileId: number | null) {
    try {
      await put(`/dubbers/${dubber.id}`, { name: dubber.name, profile_id: profileId })
      await loadRoles()
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося прив\'язати профіль'))
    }
  }

  async function removeDubber(id: number) {
    try {
      await del(`/dubbers/${id}`)
      await loadRoles()
    } catch (e) {
      setRolesError(extractApiError(e, 'Не вдалося видалити дабера'))
    }
  }

  const actorProfiles = profiles.filter(
    (p) => p.roles?.includes('actor') && !dubbers.some((d) => d.profile_id === p.id)
  )

  if (loading && !episode) {
    return (
      <div className="flex items-center justify-center h-full text-rh-muted">
        <Spinner size={20} />
      </div>
    )
  }

  const stageLabel = episode?.subtitle_stage === 'ready_for_actors'
    ? 'Надіслано акторам'
    : episode?.subtitle_stage === 'ready_for_director'
      ? 'Готово до режисури'
      : 'Очікує перекладу'

  const actorVideoJob = [...activeJobs.values()].find(
    (j) => j.episode_id === episodeId && j.type === 'export_actor_video' && j.status === 'running'
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-rh-border flex-shrink-0">
        <span className="text-sm font-medium text-rh-text">Епізод {episode?.number ?? episodeId}</span>
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-violet-900/40 text-violet-300 border border-violet-700/40">
          {stageLabel}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {actorVideoJob && (
            <span className="text-[11px] text-amber-300">
              {actorVideoJob.message} {actorVideoJob.percent > 0 ? `${actorVideoJob.percent}%` : ''}
            </span>
          )}
          {!actorVideoJob && sendResult && <span className="text-[11px] text-rh-muted">{sendResult}</span>}
          {episode?.cleaned_video_transfer_id && (
            <button onClick={handleDownloadCleanedVideo} className="rh-btn-outline text-xs" disabled={downloadingCleanedVideo}>
              {downloadingCleanedVideo ? <Spinner size={12} /> : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              )}
              Очищене відео від клінапера
            </button>
          )}
          {episode?.cleaned_video_transfer_id && !episode?.cleaned_video_sent_to_sound_engineer_at && (
            <button onClick={handleSendCleanedVideoToSoundEngineer} className="rh-btn-outline text-xs" disabled={sendingCleanedVideo}>
              {sendingCleanedVideo ? <Spinner size={12} /> : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>
                </svg>
              )}
              Відправити звукорежисеру
            </button>
          )}
          {episode?.cleaned_video_sent_to_sound_engineer_at && (
            <span className="text-[11px] text-rh-accent">✓ Передано звукорежисеру</span>
          )}
          <button onClick={handleSendToActors} className="rh-btn-outline text-xs" disabled={!backendReady || sendingToActors || !!actorVideoJob}>
            {sendingToActors || actorVideoJob ? <Spinner size={12} /> : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>
              </svg>
            )}
            {episode?.subtitle_stage === 'ready_for_actors' ? 'Надіслано акторам' : 'Надіслати акторам'}
          </button>
          <button onClick={handleExportSrt} className="rh-btn-outline text-xs" disabled={!backendReady}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Експорт SRT + ASS
          </button>
          <button onClick={() => assInputRef.current?.click()} className="rh-btn-outline text-xs" disabled={importingAss}>
            {importingAss ? <Spinner size={12} /> : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
            )}
            Імпорт ASS/SRT
          </button>
          <input ref={assInputRef} type="file" accept=".ass,.srt" className="hidden" onChange={(e) => { if (e.target.files) handleAssImport(e.target.files) }} />
        </div>
      </div>

      {/* Main workspace */}
      <div ref={workspaceRef} className="flex-1 flex flex-col overflow-hidden">
        {/* Video + waveform — always visible regardless of which tab is active below */}
        <div ref={topRowRef} className="flex p-2 flex-shrink-0" style={{ height: `${videoHeightPct}%` }}>
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
              vocalStemPath={null}
              subtitles={subtitles}
              activeSubIndex={activeSubIndex}
              onTimeUpdate={handleTimeUpdate}
              onDurationChange={setDuration}
            />
          </div>

          <div
            onMouseDown={startVideoResize}
            className="w-2 flex-shrink-0 cursor-col-resize group flex items-center justify-center"
            title="Перетягніть, щоб змінити розмір відео"
          >
            <div className="w-1 h-8 rounded-full bg-rh-border group-hover:bg-rh-accent transition-colors" />
          </div>

          <div style={{ width: `calc(${100 - videoWidthPct}% - 8px)` }} className="flex-shrink-0">
            <WaveformViewer
              audioPath={episode?.original_file_path ?? null}
              currentTime={currentTimeMs / 1000}
              duration={duration}
              markers={[]}
              onSeek={(t) => videoRef.current?.seek(t)}
              onMarkerClick={() => {}}
              backendPort={backendPort}
              label="Аудіо"
              emptyMessage="Відео відсутнє"
              lines={subtitles}
              activeIndex={activeSubIndex}
              onLineTimingChange={handleSubLineChange}
              onLineActivate={handleSubLineClick}
            />
          </div>
        </div>

        <div
          onMouseDown={startVideoResizeVertical}
          className="h-2 flex-shrink-0 cursor-row-resize group flex items-center justify-center"
          title="Перетягніть, щоб змінити висоту відео"
        >
          <div className="h-1 w-8 rounded-full bg-rh-border group-hover:bg-rh-accent transition-colors" />
        </div>

        {/* Bottom: Репліки / Ролі tabs */}
        <div className="flex flex-col flex-1 overflow-hidden border-t border-rh-border">
          <div className="flex items-center gap-0 px-2 border-b border-rh-border bg-rh-card2 flex-shrink-0">
            <TabButton active={activeTab === 'lines'} onClick={() => setActiveTab('lines')}>
              Репліки
              <span className="ml-1.5 text-rh-muted text-xs">{subtitles.length}</span>
            </TabButton>
            <TabButton active={activeTab === 'markers'} onClick={() => setActiveTab('markers')}>
              Маркери
              <span className="ml-1.5 text-rh-muted text-xs">{markers.length}</span>
            </TabButton>
            {audioSubmissions.length > 0 && (
              <TabButton active={activeTab === 'audio'} onClick={() => setActiveTab('audio')}>
                Звук
                <span className="ml-1.5 text-rh-muted text-xs">{audioSubmissions.length}</span>
              </TabButton>
            )}
            <TabButton active={activeTab === 'roles'} onClick={() => setActiveTab('roles')}>
              Ролі
              <span className="ml-1.5 text-rh-muted text-xs">{characters.length}</span>
            </TabButton>
          </div>

          <div
            className="flex-1 overflow-hidden relative"
            onDragOver={activeTab === 'lines' ? handleAssDragOver : activeTab === 'markers' ? handleMarkersDragOver : undefined}
            onDragLeave={activeTab === 'lines' ? handleAssDragLeave : activeTab === 'markers' ? handleMarkersDragLeave : undefined}
            onDrop={activeTab === 'lines' ? handleAssDrop : activeTab === 'markers' ? handleMarkersDrop : undefined}
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
            {activeTab === 'lines' ? (
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
            ) : activeTab === 'audio' ? (
              <div className="h-full overflow-y-auto p-4 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <span className="text-[11px] text-rh-muted">
                    Виберіть доріжки та відправте звукорежисеру, коли готові
                  </span>
                  <button
                    onClick={handleSendToSoundEngineer}
                    disabled={selectedAudioIds.size === 0}
                    className="rh-btn-primary text-xs flex-shrink-0 disabled:opacity-40"
                  >
                    Відправити звукорежисеру ({selectedAudioIds.size})
                  </button>
                </div>
                {audioActionResult && (
                  <div className="text-[11px] text-rh-accent flex items-center gap-2">
                    {audioActionResult}
                    <button onClick={() => setAudioActionResult(null)} className="text-rh-muted hover:text-white">✕</button>
                  </div>
                )}
                {audioSubmissions.map((s) => {
                  const original = s.fix_of_submission_id
                    ? audioSubmissions.find((o) => o.id === s.fix_of_submission_id)
                    : null
                  return (
                  <div key={s.id} className="bg-rh-card border border-rh-border rounded-2xl px-4 py-3 flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      {s.fix_of_submission_id ? (
                        <span className="text-[11px] flex-shrink-0" title="Виправлення — не входить у звичайний масовий відбір">🔧</span>
                      ) : (
                        <input
                          type="checkbox"
                          checked={selectedAudioIds.has(s.id)}
                          onChange={() => toggleAudioSelect(s.id)}
                          className="flex-shrink-0"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] font-bold truncate">{s.filename}</div>
                        <div className="text-[10.5px] text-rh-muted mt-0.5">
                          {s.character_name ?? '—'} · {s.uploaded_by_name} · {new Date(s.created_at).toLocaleString()}
                          {original && ` · виправлення до «${original.filename}»`}
                        </div>
                      </div>
                      <button
                        onClick={async () => {
                          try {
                            const result = await get<{ url: string }>(`/episodes/${episodeId}/actor-audio/${s.id}/url`)
                            window.open(result.url, '_blank')
                          } catch {
                            /* ignore — transient signaling hiccup */
                          }
                        }}
                        className="rh-btn-outline text-xs flex-shrink-0"
                      >
                        Завантажити
                      </button>
                      {s.fix_of_submission_id && (
                        s.accepted_at ? (
                          <span className="text-[10.5px] text-rh-accent flex-shrink-0">✓ Прийнято</span>
                        ) : (
                          <button
                            onClick={() => handleAcceptFix(s.id, s.filename)}
                            className="rh-btn-primary text-xs flex-shrink-0"
                          >
                            Прийняти
                          </button>
                        )
                      )}
                    </div>
                    <div className="flex flex-col gap-2 pl-7">
                      <textarea
                        value={fixDrafts[s.id] ?? ''}
                        onChange={(e) => setFixDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))}
                        placeholder="Правки для актора…"
                        rows={3}
                        className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px] resize-y"
                      />
                      <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => handleRequestFix(s.id)}
                        disabled={!(fixDrafts[s.id] ?? '').trim() && !fixMarkerFilePaths[s.id]}
                        className="rh-btn-primary text-[11px] px-2.5 py-1.5 flex-shrink-0 disabled:opacity-40"
                      >
                        Відправити
                      </button>
                      <button
                        onClick={() => fixMarkerInputRefs.current[s.id]?.click()}
                        className="rh-btn-outline text-[11px] px-2.5 py-1.5 flex-shrink-0"
                        title="Скачайте доріжку, перевірте в Reaper, експортуйте маркери фіксів і додайте CSV — надішлеться разом з текстом одним натисканням «Відправити»"
                      >
                        {fixMarkerFilePaths[s.id]
                          ? `Маркери: ${fixMarkerFilePaths[s.id].split(/[\\/]/).pop()}`
                          : `Додати маркери фіксів (.csv)${s.fix_marker_count > 0 ? ` — вже ${s.fix_marker_count}` : ''}`}
                      </button>
                      {fixMarkerFilePaths[s.id] && (
                        <button
                          onClick={() => setFixMarkerFilePaths((prev) => { const next = { ...prev }; delete next[s.id]; return next })}
                          className="text-[10.5px] text-rh-muted hover:text-white"
                        >
                          ✕
                        </button>
                      )}
                      <input
                        ref={(el) => { fixMarkerInputRefs.current[s.id] = el }}
                        type="file"
                        accept=".csv"
                        className="hidden"
                        onChange={(e) => {
                          const filePath = (e.target.files?.[0] as (File & { path?: string }) | undefined)?.path
                          if (filePath) setFixMarkerFilePaths((prev) => ({ ...prev, [s.id]: filePath }))
                          e.target.value = ''
                        }}
                      />
                      </div>
                    </div>
                    {s.fix_message && (
                      <div className="pl-7 text-[10.5px] text-rh-muted whitespace-pre-wrap">
                        Останні правки: «{s.fix_message}»
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            ) : activeTab === 'roles' ? (
              <div className="h-full overflow-y-auto p-4">
                {rolesError && (
                  <div className="mb-3 text-[11px] text-[#FF6B70] flex items-center gap-2">
                    {rolesError}
                    <button onClick={() => setRolesError(null)} className="text-rh-muted hover:text-white">✕</button>
                  </div>
                )}

                <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden mb-5 max-w-[760px]">
                  <div className="px-4 py-3 border-b border-rh-border/70 text-[12.5px] font-bold">Персонажі цього тайтлу</div>
                  <div className="flex flex-col">
                    {characters.length === 0 && (
                      <div className="px-4 py-3 text-[11.5px] text-rh-muted">Ще немає жодного персонажа — додайте нижче.</div>
                    )}
                    {characters.map((c) => (
                      <div key={c.id} className="flex items-center gap-2.5 px-4 py-2.5 border-b border-rh-border/50 last:border-b-0">
                        <div className="flex-1 min-w-0">
                          <span className="text-[12.5px] font-semibold">{c.name}</span>
                          {c.code && <span className="ml-1.5 text-[10.5px] font-mono text-rh-muted">{c.code}</span>}
                        </div>
                        {/* Assigns Character.team_device_id directly — the
                            same field the subtitle grid's own АКТОР dropdown
                            sets, so an actor who already picked themselves
                            there shows up pre-selected here too (see
                            assignTeamActor's own comment). Replaces the old
                            local-profile-only Dubber dropdown, which real
                            team actors could never appear in. */}
                        <select
                          value={c.team_device_id ?? ''}
                          onChange={(e) => assignTeamActor(c.id, e.target.value || null)}
                          className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1 text-[11px] max-w-[180px]"
                        >
                          <option value="">— без актора —</option>
                          {teamActors.map((a) => (
                            <option key={a.device_id} value={a.device_id}>{a.display_name}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => handleSendToOneActor(c.id)}
                          disabled={!c.team_device_id || c.team_device_id === 'everyone' || sendingToActorId === c.id}
                          title="Надіслати відео та субтитри тільки цьому актору"
                          className="rh-btn-outline text-[10.5px] px-2 py-1 flex-shrink-0 disabled:opacity-30 flex items-center gap-1"
                        >
                          {sendingToActorId === c.id ? <Spinner size={10} /> : '📨'}
                        </button>
                        <button onClick={() => removeCharacter(c.id)} className="text-rh-muted hover:text-red-400 text-xs flex-shrink-0">✕</button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 px-4 py-3 border-t border-rh-border/70">
                    <input
                      value={newCharName}
                      onChange={(e) => setNewCharName(e.target.value)}
                      placeholder="Ім'я персонажа"
                      className="flex-1 bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px]"
                    />
                    <input
                      value={newCharCode}
                      onChange={(e) => setNewCharCode(e.target.value)}
                      placeholder="Код (напр. ГГ)"
                      className="w-28 bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px] font-mono"
                    />
                    <button onClick={addCharacter} disabled={!newCharName.trim()} className="rh-btn-primary text-[11px] px-3 py-1.5 disabled:opacity-40">
                      Додати
                    </button>
                  </div>
                </div>

                <div className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden max-w-[760px]">
                  <div className="px-4 py-3 border-b border-rh-border/70">
                    <div className="text-[12.5px] font-bold">Дабери (актори)</div>
                    <div className="text-[10.5px] text-rh-muted mt-0.5">
                      Прив'язка до профілю — щоб актор бачив свої репліки й маркери на вкладці "Актор". Профілі — локальні для цього ПК.
                    </div>
                  </div>

                  {/* Profiles that already carry the "actor" role — one click
                      to become a Dubber, instead of retyping their name and
                      separately linking it via the plain dropdown below. */}
                  {actorProfiles.length > 0 && (
                    <div className="flex flex-col border-b border-rh-border/70">
                      {actorProfiles.map((p) => (
                        <div key={p.id} className="flex items-center gap-2.5 px-4 py-2.5 border-b border-rh-border/50 last:border-b-0 bg-emerald-900/10">
                          <span className="flex-1 min-w-0 text-[12.5px] font-semibold truncate">{p.name}</span>
                          <span className="text-[10.5px] text-emerald-400 flex-shrink-0">профіль з роллю «Актор»</span>
                          <button onClick={() => addDubberFromProfile(p)} className="rh-btn-outline text-[11px] px-2.5 py-1 flex-shrink-0">
                            Додати як дабера
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-col">
                    {dubbers.length === 0 && (
                      <div className="px-4 py-3 text-[11.5px] text-rh-muted">Ще немає жодного дабера — додайте нижче.</div>
                    )}
                    {dubbers.map((d) => (
                      <div key={d.id} className="flex items-center gap-2.5 px-4 py-2.5 border-b border-rh-border/50 last:border-b-0">
                        <span className="flex-1 min-w-0 text-[12.5px] font-semibold truncate">{d.name}</span>
                        <select
                          value={d.profile_id ?? ''}
                          onChange={(e) => linkDubberProfile(d, e.target.value ? Number(e.target.value) : null)}
                          className="bg-rh-bg border border-rh-border rounded-lg px-2 py-1 text-[11px] max-w-[180px]"
                        >
                          <option value="">— не прив'язано —</option>
                          {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                        <button onClick={() => removeDubber(d.id)} className="text-rh-muted hover:text-red-400 text-xs flex-shrink-0">✕</button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 px-4 py-3 border-t border-rh-border/70">
                    <input
                      value={newDubberName}
                      onChange={(e) => setNewDubberName(e.target.value)}
                      placeholder="Ім'я дабера (без локального профілю)"
                      className="flex-1 bg-rh-bg border border-rh-border rounded-lg px-2 py-1.5 text-[11px]"
                    />
                    <button onClick={addDubber} disabled={!newDubberName.trim()} className="rh-btn-primary text-[11px] px-3 py-1.5 disabled:opacity-40">
                      Додати
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
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
