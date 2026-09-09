import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { VideoPlayer, type VideoPlayerHandle } from './workspace/VideoPlayer'
import { WaveformViewer } from './workspace/WaveformViewer'
import { SubtitleGrid } from './workspace/SubtitleGrid'
import { SubtitleEditBox } from './workspace/SubtitleEditBox'
import { Spinner } from './ui/Spinner'
import type { Episode, SubtitleLine, Character, Title, TeamActor } from '../types'

interface TranslatorWorkspaceProps {
  episodeId: number
  titleId: number
}

// Deliberately a separate, lighter component rather than a mode of
// EpisodeWorkspace — the translator role gets video + subtitle grid only,
// no vocal isolation, markers, rendering, or any of the sound-engineer
// tooling (see the request that added per-role workspaces).
export function TranslatorWorkspace({ episodeId, titleId }: TranslatorWorkspaceProps) {
  const { get, post, put, del } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const backendPort = useAppStore((s) => s.backendPort)
  const activeJobs = useAppStore((s) => s.activeJobs)
  const upsertJob = useAppStore((s) => s.upsertJob)

  const [episode, setEpisode] = useState<Episode | null>(null)
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [teamActors, setTeamActors] = useState<TeamActor[]>([])
  const [loading, setLoading] = useState(false)
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [duration, setDuration] = useState(0)
  const subtitlesUndoStackRef = useRef<SubtitleLine[][]>([])
  const subtitlesRedoStackRef = useRef<SubtitleLine[][]>([])
  const videoRef = useRef<VideoPlayerHandle>(null)

  // Video/waveform split — same drag-to-resize pattern as EpisodeWorkspace,
  // but with its own localStorage keys: a translator's default split is
  // likely to differ from an engineer's, and the two shouldn't fight over
  // one saved value.
  const [videoWidthPct, setVideoWidthPct] = useState(() => {
    const saved = Number(localStorage.getItem('rh_translator_video_width_pct'))
    // Default ~40/60 video/waveform split — matches Aegisub's own proportions
    // (its video pane is the smaller of the two, audio display gets most of
    // the width) rather than the sound-engineer workspace's 65/35, which
    // favors video since that one has no per-line waveform editing at all.
    return saved >= 20 && saved <= 85 ? saved : 38
  })
  const [videoHeightPct, setVideoHeightPct] = useState(() => {
    const saved = Number(localStorage.getItem('rh_translator_video_height_pct'))
    return saved >= 20 && saved <= 75 ? saved : 42
  })
  const topRowRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const resizingRef = useRef(false)

  // ASS import — drag-and-drop onto the grid, or the explicit button below
  // (see EpisodeWorkspace's identical handleAssImport/handleAssDrop, which
  // this mirrors: a translator has no other way to get subtitles into the
  // episode at all otherwise).
  const assInputRef = useRef<HTMLInputElement>(null)
  const [importingAss, setImportingAss] = useState(false)
  const [assDragOver, setAssDragOver] = useState(false)

  useEffect(() => {
    if (!backendReady) return
    setLoading(true)
    Promise.all([
      get<Episode>(`/episodes/${episodeId}`),
      get<SubtitleLine[]>(`/episodes/${episodeId}/subtitle-lines`),
      get<Character[]>(`/characters?title_id=${titleId}`),
    ])
      .then(([ep, subs, chars]) => {
        setEpisode(ep)
        setSubtitles(subs)
        setCharacters(chars)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [backendReady, episodeId, titleId, get])

  // АКТОР dropdown source — team actors, not free-typed/ASS-derived
  // characters (see SubtitleGrid/SubtitleEditBox's teamActors prop). Empty
  // array (no-op fallback to the old free-text flow) if this title isn't
  // shared with a team, same "hide, don't block" posture as every other
  // team-gated piece of UI.
  useEffect(() => {
    if (!backendReady) return
    get<Title>(`/titles/${titleId}`)
      .then((title) => (title.team_id ? get<TeamActor[]>(`/teams/${title.team_id}/actors`) : []))
      .then(setTeamActors)
      .catch(() => setTeamActors([]))
  }, [backendReady, titleId, get])

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
      localStorage.setItem('rh_translator_video_width_pct', String(lastPct))
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
      localStorage.setItem('rh_translator_video_height_pct', String(lastPct))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [videoHeightPct])

  // Same export as EpisodeWorkspace's own "Експорт SRT + ASS" button — one
  // zip with a per-actor .srt each plus the full combined .ass (see
  // backend/services/srt_exporter.py). Translator has no other export
  // surface at all otherwise.
  async function handleExportSrt() {
    if (!backendReady) return
    const url = `http://localhost:${backendPort}/api/episodes/${episodeId}/export-srt`
    window.open(url, '_blank')
  }

  // Marks the episode ready for the director and best-effort notifies
  // whoever on the team has the director role via Telegram (see
  // discovery_service.notify_director on the backend). `notified` distinguishes
  // "no team/signaling configured" (null) from "team exists but nobody has
  // the director role + Telegram linked" (0) from an actual send count.
  const [sendingToDirector, setSendingToDirector] = useState(false)
  const [sendResult, setSendResult] = useState<string | null>(null)
  async function handleSendToDirector() {
    if (!backendReady || sendingToDirector) return
    setSendingToDirector(true)
    setSendResult(null)
    try {
      const result = await post<{ subtitle_stage: string; notified: number | null }>(
        `/episodes/${episodeId}/send-to-director`, {},
      )
      setEpisode((prev) => (prev ? { ...prev, subtitle_stage: result.subtitle_stage } : prev))
      if (result.notified == null) {
        setSendResult('Надіслано (без сповіщення — немає активної команди)')
      } else if (result.notified === 0) {
        setSendResult('Надіслано, але жоден режисер не знайдений у команді')
      } else {
        setSendResult(`Надіслано, сповіщено ${result.notified} режисера(ів)`)
      }
    } catch {
      setSendResult('Помилка надсилання')
    } finally {
      setSendingToDirector(false)
    }
  }

  async function handleAssImport(files: FileList) {
    const file = files[0]
    if (!file) return
    // Same as DirectorWorkspace's own handleAssImport (see that file's
    // comment) — always keeps actor assignments, matched server-side by
    // exact timing with a same-line-count positional fallback.
    setImportingAss(true)
    try {
      if (backendReady) {
        const result = await post<{ job_id: string }>(`/episodes/${episodeId}/import-ass`, {
          file_path: (file as File & { path?: string }).path ?? '', preserve_assignments: true,
        })
        // JobStatus.type has no 'import_ass' literal — 'export_srt' is a
        // harmless placeholder here too, matching EpisodeWorkspace's own
        // identical import job registration; only episode_id/status matter
        // to the completion effect below.
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

  // Refetch subtitles once the import-ASS background job for this episode
  // finishes — same pattern as EpisodeWorkspace's live-refresh effect,
  // trimmed to the one job this workspace can ever trigger (no type check:
  // the type is a placeholder, see handleAssImport above).
  const handledJobIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!backendReady) return
    for (const job of activeJobs.values()) {
      if (job.episode_id !== episodeId) continue
      if (job.status !== 'complete') continue
      if (handledJobIdsRef.current.has(job.id)) continue
      handledJobIdsRef.current.add(job.id)
      if (job.type === 'download_original_video') {
        get<Episode>(`/episodes/${episodeId}`).then(setEpisode).catch(() => {})
        continue
      }
      get<SubtitleLine[]>(`/episodes/${episodeId}/subtitle-lines`).then(setSubtitles).catch(() => {})
      get<Character[]>(`/characters?title_id=${titleId}`).then(setCharacters).catch(() => {})
    }
  }, [activeJobs, backendReady, episodeId, titleId, get])

  // Shared episode's original video sits in R2 until someone actually asks
  // for it — see DirectorWorkspace's identical handler for the fuller
  // explanation (sync_service.download_episode_video's own comment).
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
      /* ignore */
    } finally {
      setDownloadingOriginal(false)
    }
  }
  const downloadingOriginalJob = [...activeJobs.values()].find(
    (j) => j.episode_id === episodeId && j.type === 'download_original_video' && j.status === 'running'
  )

  // Same "keep the already-active line active while the playhead is still
  // within its own range" logic as EpisodeWorkspace — overlapping lines
  // (sign/overlay text) would otherwise fight an explicit row click.
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
    // Select the line this just created — see EpisodeWorkspace's identical
    // handleAddSubLine for why this is safe against the playhead-sync
    // effect's own independent search (start_ms == currentTimeMs here too).
    setSubtitles((prev) => {
      const next = [...prev, created].sort((a, b) => a.start_ms - b.start_ms)
      setActiveSubIndex(next.findIndex((l) => l.id === created.id))
      return next
    })
    return created
  }, [episodeId, currentTimeMs, backendReady, post, subtitles, pushUndo])

  // SubtitleEditBox's Enter key: commit the text, then move on — to the
  // next existing line if there is one, otherwise create a fresh one.
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

  // Translator-only (see SubtitleEditBox's onTranslate — optional prop,
  // EpisodeWorkspace doesn't pass it, so the buttons never render there).
  // Backend resolves prev/next-line context itself from the DB; this just
  // forwards which line + provider and hands back the translated string —
  // SubtitleEditBox applies it to its own draft, never auto-committed.
  const handleEditBoxTranslate = useCallback(async (id: number, provider: 'deepl' | 'gpt' | 'gemini' | 'mymemory') => {
    const result = await post<{ text: string }>(`/subtitle-lines/${id}/translate`, { provider })
    return result.text
  }, [post])

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

  // Syncs a restored snapshot (from either stack) back to the backend —
  // shared by both undo and redo, which only differ in which stack they
  // pop from and which one they push the pre-restore state onto.
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

  if (loading && !episode) {
    return (
      <div className="flex items-center justify-center h-full text-rh-muted">
        <Spinner size={20} />
      </div>
    )
  }

  return (
    <div ref={workspaceRef} className="flex flex-col h-full overflow-hidden">
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

      <div className="flex flex-col flex-1 overflow-hidden border-t border-rh-border">
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-rh-border bg-rh-card2 flex-shrink-0 text-[12px] font-semibold text-rh-muted">
          Репліки
          <span className="text-rh-muted text-xs">{subtitles.length}</span>
          <div className="ml-auto flex items-center gap-2">
            {sendResult && <span className="text-[11px] text-rh-muted">{sendResult}</span>}
            <button onClick={handleSendToDirector} className="rh-btn-outline text-xs" disabled={!backendReady || sendingToDirector}>
              {sendingToDirector ? <Spinner size={12} /> : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/>
                </svg>
              )}
              {episode?.subtitle_stage === 'ready_for_director' ? 'Надіслано режисеру' : 'Надіслати режисеру'}
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
        <div
          className="flex-1 overflow-hidden relative"
          onDragOver={handleAssDragOver}
          onDragLeave={handleAssDragLeave}
          onDrop={handleAssDrop}
        >
          {assDragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-rh-bg/90 border-2 border-dashed border-rh-accent pointer-events-none">
              <span className="text-sm font-semibold text-rh-accent">Відпустіть, щоб імпортувати ASS/SRT-файл</span>
            </div>
          )}
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
              onTranslate={handleEditBoxTranslate}
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
        </div>
      </div>
    </div>
  )
}
