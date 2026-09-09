import React, { useEffect, useRef, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { Spinner } from './ui/Spinner'
import type { ActorAudioSubmission, Character, Episode } from '../types'

interface ActorWorkspaceProps {
  episodeId: number
  titleId: number
}

// The "actor" role's own workspace — deliberately NOT the full
// EpisodeWorkspace (separation/markers/subtitle-grid editing isn't their
// job): just "give me my own lines, my own markers, and the video" for
// whichever character(s) their Profile is linked to as a Dubber (see
// backend Dubber.profile_id and /titles/{id}/my-character).
export function ActorWorkspace({ episodeId, titleId }: ActorWorkspaceProps) {
  const { get, post, del } = useApi()
  const backendPort = useAppStore((s) => s.backendPort)
  const activeJobs = useAppStore((s) => s.activeJobs)
  const upsertJob = useAppStore((s) => s.upsertJob)
  const sharedContentUpdatedAt = useAppStore((s) => s.sharedContentUpdatedAt)
  const [characters, setCharacters] = useState<Character[] | null>(null)
  const [episode, setEpisode] = useState<Episode | null>(null)
  const [downloadingVideo, setDownloadingVideo] = useState(false)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [audioSubmissions, setAudioSubmissions] = useState<ActorAudioSubmission[]>([])
  const audioInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const fixAudioInputRefs = useRef<Record<number, HTMLInputElement | null>>({})
  const handledAudioJobIdsRef = useRef(new Set<string>())

  useEffect(() => {
    get<Character[]>(`/titles/${titleId}/my-character`).then(setCharacters).catch(() => setCharacters([]))
    get<Episode>(`/episodes/${episodeId}`).then(setEpisode).catch(() => {})
  }, [get, titleId, episodeId])

  const loadAudioSubmissions = React.useCallback(() => {
    get<ActorAudioSubmission[]>(`/episodes/${episodeId}/actor-audio`).then(setAudioSubmissions).catch(() => {})
  }, [get, episodeId])

  useEffect(() => { loadAudioSubmissions() }, [loadAudioSubmissions])

  // A teammate's fix request/marker import pushes this (see sync_service.py's
  // _notify_team) — without listening for it, a fix request never showed up
  // here until the actor happened to leave and re-enter this tab (which
  // remounts the component and re-triggers the plain mount-effect above).
  // Note: the Worker's own relay excludes the SENDER's own device_id, so on
  // a single machine simulating both director and actor via the same
  // profile/device this alone won't fire — the polling fallback below
  // covers exactly that case, and this covers the real cross-device one.
  useEffect(() => { if (sharedContentUpdatedAt) loadAudioSubmissions() }, [sharedContentUpdatedAt, loadAudioSubmissions])

  // Belt-and-suspenders polling while this tab stays open — a fix request
  // has no OTHER live-push path to the actor's own screen (no per-job
  // WebSocket message like an upload has), so without this the only way to
  // see a fresh fix was leaving and re-entering the episode.
  useEffect(() => {
    const id = setInterval(loadAudioSubmissions, 8000)
    return () => clearInterval(id)
  }, [loadAudioSubmissions])

  // Refetches the submissions list once each "Здати" job finishes — same
  // WS-driven job-store pattern every other background action in this app
  // uses (see DirectorWorkspace's handleSendToActors for the identical shape).
  useEffect(() => {
    for (const job of activeJobs.values()) {
      if (job.type !== 'submit_actor_audio' || job.episode_id !== episodeId) continue
      if (job.status !== 'complete' && job.status !== 'error') continue
      if (handledAudioJobIdsRef.current.has(job.id)) continue
      handledAudioJobIdsRef.current.add(job.id)
      if (job.status === 'complete') loadAudioSubmissions()
    }
  }, [activeJobs, episodeId, loadAudioSubmissions])

  const handledReaperJobIdsRef = useRef(new Set<string>())
  const [reaperError, setReaperError] = useState<string | null>(null)
  // Once the project's actually built server-side (video downloaded +
  // .rpp written next to it — see reaper_project_service.py), hand the
  // .rpp path to the OS the same way "Відкрити" opens the episode video —
  // whatever's registered for .rpp on this machine (Reaper itself, once
  // installed) takes it from there.
  useEffect(() => {
    for (const job of activeJobs.values()) {
      if (job.type !== 'generate_actor_reaper_project' || job.episode_id !== episodeId) continue
      if (job.status !== 'complete' && job.status !== 'error') continue
      if (handledReaperJobIdsRef.current.has(job.id)) continue
      handledReaperJobIdsRef.current.add(job.id)
      if (job.status === 'complete') {
        const rppPath = job.result?.rpp_path as string | undefined
        if (rppPath) window.electronAPI?.openPath(rppPath)
      } else {
        setReaperError(job.message || 'Не вдалося створити проєкт Reaper')
      }
    }
  }, [activeJobs, episodeId])

  async function openInReaper(characterId: number) {
    setReaperError(null)
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/actor-reaper-project`, {
        character_id: characterId,
      })
      upsertJob({
        id: result.job_id, type: 'generate_actor_reaper_project', status: 'running', percent: 0,
        message: 'Готую проєкт Reaper…', episode_id: episodeId, character_id: characterId,
      })
    } catch {
      setReaperError('Не вдалося створити проєкт Reaper')
    }
  }

  // "Здати" — no per-line slicing on the actor's end at all, just however
  // many recorded files they want to hand in (see backend
  // actor_audio_service.py's own docstring for why). Job-based since a WAV
  // can be hundreds of MB.
  async function submitAudioFiles(characterId: number, files: FileList) {
    for (let i = 0; i < files.length; i++) {
      const filePath = (files[i] as File & { path?: string }).path
      if (!filePath) continue
      try {
        const result = await post<{ job_id: string }>(`/episodes/${episodeId}/actor-audio`, {
          file_path: filePath, character_id: characterId,
        })
        upsertJob({
          id: result.job_id, type: 'submit_actor_audio', status: 'running', percent: 0,
          message: `Здаю ${files[i].name}…`, episode_id: episodeId, filename: files[i].name,
        })
      } catch {
        // ignore — best-effort per file, one failure shouldn't block the rest
      }
    }
  }

  // A corrected re-take in response to a director/sound-engineer fix
  // request — same upload endpoint as submitAudioFiles, just tagged with
  // fix_of_submission_id so it links back to the original (see backend
  // ActorAudioSubmission.fix_of_submission_id) and the director sees a
  // "Прийняти" gate on it instead of it silently joining the untagged pile.
  async function submitFixAudioFile(characterId: number, file: File, fixOfSubmissionId: number) {
    const filePath = (file as File & { path?: string }).path
    if (!filePath) return
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/actor-audio`, {
        file_path: filePath, character_id: characterId, fix_of_submission_id: fixOfSubmissionId,
      })
      upsertJob({
        id: result.job_id, type: 'submit_actor_audio', status: 'running', percent: 0,
        message: `Здаю виправлення ${file.name}…`, episode_id: episodeId, filename: file.name,
        fix_of_submission_id: fixOfSubmissionId,
      })
    } catch {
      // ignore — same best-effort posture as submitAudioFiles
    }
  }

  function download(url: string) {
    window.open(url, '_blank')
  }

  // Lets the actor pull back a mistaken/duplicate upload themselves instead
  // of having to ask the director to do it — same DELETE endpoint the
  // director's own "Звук" tab has no UI for either, added here first since
  // this is the actor's own material. Confirm first: this also removes the
  // file from R2, not just the local list row (see routers/actor_audio.py's
  // delete_actor_audio).
  async function deleteSubmission(submissionId: number, filename: string) {
    if (!window.confirm(`Видалити доріжку «${filename}»? Це незворотньо.`)) return
    try {
      await del(`/episodes/${episodeId}/actor-audio/${submissionId}`)
      loadAudioSubmissions()
    } catch {
      /* ignore — transient signaling hiccup, same posture as elsewhere */
    }
  }

  function openVideo() {
    if (episode?.original_file_path) window.electronAPI?.openPath(episode.original_file_path)
  }

  // The director's "Надіслати акторам" generates this — a whole-episode
  // 480p hardsub proxy uploaded to R2 (see routers/episodes.py's
  // actor-video-url, backend/services/actor_video_service.py). The backend
  // resolves the actual R2/Worker URL on demand rather than the frontend
  // ever hardcoding it — see that endpoint's own comment.
  async function downloadActorVideo() {
    if (downloadingVideo) return
    setDownloadingVideo(true)
    setVideoError(null)
    try {
      const result = await get<{ url: string }>(`/episodes/${episodeId}/actor-video-url`)
      download(result.url)
    } catch {
      setVideoError('Відео ще не готове або недоступне')
    } finally {
      setDownloadingVideo(false)
    }
  }

  if (characters === null) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size={20} className="text-rh-accent" />
      </div>
    )
  }

  if (characters.length === 0) {
    return (
      <main className="p-5 px-6 max-w-[600px] mx-auto">
        <div className="bg-rh-card border border-rh-border rounded-2xl px-4 py-5 text-center">
          <p className="text-[13px] text-rh-text-dim leading-relaxed">
            До вашого профілю ще не прив'язано жодного персонажа в цьому тайтлі.
            Зверніться до режисера — прив'язка робиться на вкладці "Режисер"
            (список "Дабери").
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="p-5 px-6 max-w-[700px] mx-auto overflow-y-auto h-full">
      <h1 className="m-0 mb-3.5 text-lg font-black">Мої матеріали</h1>

      {reaperError && (
        <div className="mb-3 text-[11px] text-[#FF6B70] flex items-center gap-2">
          {reaperError}
          <button onClick={() => setReaperError(null)} className="text-rh-muted hover:text-white">✕</button>
        </div>
      )}

      {episode?.original_file_path && (
        <div className="bg-rh-card border border-rh-border rounded-2xl px-4 py-3.5 flex items-center justify-between mb-4">
          <div>
            <div className="text-[12.5px] font-bold">Відео епізоду</div>
            <div className="font-mono text-[11px] text-rh-text-dim mt-0.5 truncate max-w-[420px]">{episode.original_file_path}</div>
          </div>
          <button onClick={openVideo} className="rh-btn-outline text-xs flex-shrink-0">Відкрити</button>
        </div>
      )}

      {episode?.actor_video_transfer_id && (
        <div className="bg-rh-card border border-rh-border rounded-2xl px-4 py-3.5 flex items-center justify-between mb-4">
          <div>
            <div className="text-[12.5px] font-bold">Відео з субтитрами (480p)</div>
            <div className="text-[11px] text-rh-text-dim mt-0.5">
              {videoError ?? 'Стиснута копія епізоду з вшитими субтитрами — від режисера'}
            </div>
          </div>
          <button onClick={downloadActorVideo} disabled={downloadingVideo} className="rh-btn-outline text-xs flex-shrink-0 disabled:opacity-40">
            {downloadingVideo ? <Spinner size={12} /> : 'Завантажити'}
          </button>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {characters.map((c) => {
          const srtUrl = `http://localhost:${backendPort}/api/episodes/${episodeId}/export-srt?character_id=${c.id}`
          // character_id — the modern link (see Character.team_device_id,
          // set via the subtitle grid's team-actor dropdown) — is always
          // sent alongside the legacy character_code, since a title can mix
          // old ASS-derived characters (code, no team link) with new
          // team-actor ones (team link, no code). See reaper_exporter.py's
          // _filter_markers_for_actor for how the backend matches either.
          const csvUrl = `http://localhost:${backendPort}/api/episodes/${episodeId}/export-reaper-csv?character_code=${encodeURIComponent(c.code || '')}&character_id=${c.id}`
          const myUploads = audioSubmissions.filter((s) => s.character_id === c.id)
          // Fix re-takes are rendered nested under their original, not as
          // their own top-level card — see the fix-box render below.
          const topLevelUploads = myUploads.filter((s) => !s.fix_of_submission_id)
          const runningJobs = [...activeJobs.values()].filter(
            (j) => j.type === 'submit_actor_audio' && j.episode_id === episodeId && j.status === 'running'
          )
          const uploadingJobs = runningJobs.filter((j) => !j.fix_of_submission_id)
          const uploadingCount = uploadingJobs.length
          const reaperJob = [...activeJobs.values()].find(
            (j) => j.type === 'generate_actor_reaper_project' && j.episode_id === episodeId
              && j.character_id === c.id && j.status === 'running'
          )
          const downloadSubmission = async (submissionId: number) => {
            try {
              const result = await get<{ url: string }>(`/episodes/${episodeId}/actor-audio/${submissionId}/url`)
              download(result.url)
            } catch {
              /* ignore — transient signaling hiccup, same posture as elsewhere */
            }
          }
          return (
            <div key={c.id} className="bg-rh-card border border-rh-border rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-rh-border/70">
                <span className="text-[13px] font-bold">{c.name}</span>
                {c.code && <span className="ml-2 text-[10.5px] font-mono text-rh-muted">{c.code}</span>}
              </div>
              <div className="flex flex-wrap gap-2 px-4 py-3">
                <button onClick={() => download(srtUrl)} className="rh-btn-outline text-xs">Субтитри (.srt)</button>
                {/* character_id filters server-side (see reaper_exporter.py's
                    _filter_markers_for_actor) regardless of whether this
                    Character has a legacy .code — no reason to disable these
                    for a team-actor-derived character that never gets one
                    (confirmed live 2026-08-18: these stayed disabled for
                    every new-style actor even after character_id filtering
                    already worked). */}
                <button onClick={() => download(csvUrl)} className="rh-btn-outline text-xs">
                  Маркери (.csv)
                </button>
                {/* Downloads the hardsub video (if needed) + builds a ready
                    .rpp project (reference track quiet + empty rec track +
                    line-text markers) and hands it to the OS — see
                    reaper_project_service.py. */}
                <button
                  onClick={() => openInReaper(c.id)}
                  disabled={!!reaperJob}
                  className="rh-btn-outline text-xs flex items-center gap-1.5 disabled:opacity-60"
                  title="Завантажує відео-орієнтир і створює готовий проєкт Reaper з маркерами реплік"
                >
                  {reaperJob ? <><Spinner size={12} />{reaperJob.percent}%</> : 'Відкрити в Reaper'}
                </button>
                {/* "Здати" — however many recorded files, no per-line slicing
                    on the actor's end (see actor_audio_service.py). */}
                <button
                  onClick={() => audioInputRefs.current[c.id]?.click()}
                  disabled={uploadingCount > 0}
                  className="rh-btn-primary text-xs flex items-center gap-1.5 disabled:opacity-60"
                >
                  {uploadingCount > 0 ? <Spinner size={12} /> : null}
                  Здати звукові доріжки
                </button>
                <input
                  ref={(el) => { audioInputRefs.current[c.id] = el }}
                  type="file"
                  accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a"
                  multiple
                  className="hidden"
                  onChange={(e) => { if (e.target.files?.length) submitAudioFiles(c.id, e.target.files); e.target.value = '' }}
                />
              </div>
              {uploadingJobs.length > 0 && (
                <div className="px-4 pb-3 flex flex-col gap-1.5">
                  {uploadingJobs.map((j) => (
                    <div key={j.id} className="flex flex-col gap-0.5">
                      <div className="flex items-center justify-between text-[10.5px] text-rh-muted font-mono">
                        <span className="truncate">{j.filename ?? '…'}</span>
                        <span className="flex-shrink-0 ml-2">{j.percent}%</span>
                      </div>
                      <div className="h-1 rounded-full bg-rh-bg overflow-hidden">
                        <div
                          className="h-full bg-rh-accent transition-all"
                          style={{ width: `${j.percent}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {topLevelUploads.length > 0 && (
                <div className="px-4 pb-3 flex flex-col gap-2.5">
                  {topLevelUploads.map((s) => {
                    const needsFix = !!(s.fix_message || s.fix_marker_count > 0)
                    const fixResponse = myUploads.find((s2) => s2.fix_of_submission_id === s.id)
                    const fixUploadingJob = runningJobs.find((j) => j.fix_of_submission_id === s.id)
                    return (
                      <div key={s.id} className="flex flex-col gap-1.5">
                        {/* Completed-upload card: filename, a full progress
                            bar (visual confirmation it actually made it up),
                            and a download button so the actor can double-
                            check what was sent — previously this was just a
                            small grey text line with no way to verify. */}
                        <div className="bg-rh-bg border border-rh-border rounded-lg px-3 py-2 flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-[11px] font-bold truncate">{s.filename}</div>
                            <div className="h-1 rounded-full bg-rh-border overflow-hidden mt-1.5">
                              <div className="h-full bg-green-500 w-full" />
                            </div>
                            <div className="text-[10px] text-rh-muted mt-1">{new Date(s.created_at).toLocaleString()}</div>
                          </div>
                          <div className="flex flex-col gap-1.5 flex-shrink-0">
                            <button
                              onClick={() => downloadSubmission(s.id)}
                              className="rh-btn-outline text-[10.5px] px-2.5 py-1.5"
                            >
                              Завантажити
                            </button>
                            <button
                              onClick={() => deleteSubmission(s.id, s.filename)}
                              className="text-[10.5px] px-2.5 py-1.5 rounded-lg border border-red-900/40 text-red-400 hover:bg-red-950/30"
                            >
                              Видалити
                            </button>
                          </div>
                        </div>

                        {needsFix && (
                          <div className="bg-rh-bg border border-rh-border rounded-lg px-2.5 py-2 flex flex-col gap-1.5 ml-3">
                            {s.fix_message && (
                              <div className="text-[11px] text-rh-text">
                                {s.fix_requested_by_role === 'sound_engineer' ? 'Звукорежисер' : 'Режисер'} просить правки: «{s.fix_message}»
                              </div>
                            )}
                            {s.fix_marker_count > 0 && (
                              <button
                                onClick={() => download(`http://localhost:${backendPort}/api/episodes/${episodeId}/actor-audio/${s.id}/fix-markers/export-csv`)}
                                className="rh-btn-outline text-[10.5px] px-2 py-1 self-start"
                              >
                                Маркери фіксів (.csv) — {s.fix_marker_count}
                              </button>
                            )}
                            {fixResponse ? (
                              <div className="text-[10.5px] text-rh-muted">
                                {fixResponse.accepted_at
                                  ? `✓ Прийнято режисером (${fixResponse.accepted_by_name ?? '?'}), ${new Date(fixResponse.accepted_at).toLocaleString()}`
                                  : `Виправлення надіслано: ${fixResponse.filename} — очікує прийняття режисером`}
                              </div>
                            ) : fixUploadingJob ? (
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center justify-between text-[10.5px] text-rh-muted font-mono">
                                  <span className="truncate">{fixUploadingJob.filename ?? '…'}</span>
                                  <span className="flex-shrink-0 ml-2">{fixUploadingJob.percent}%</span>
                                </div>
                                <div className="h-1 rounded-full bg-rh-border overflow-hidden">
                                  <div className="h-full bg-rh-accent transition-all" style={{ width: `${fixUploadingJob.percent}%` }} />
                                </div>
                              </div>
                            ) : (
                              <>
                                <button
                                  onClick={() => fixAudioInputRefs.current[s.id]?.click()}
                                  className="rh-btn-primary text-[10.5px] px-2.5 py-1.5 self-start"
                                >
                                  Завантажити виправлену доріжку
                                </button>
                                <input
                                  ref={(el) => { fixAudioInputRefs.current[s.id] = el }}
                                  type="file"
                                  accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a"
                                  className="hidden"
                                  onChange={(e) => {
                                    if (e.target.files?.[0]) submitFixAudioFile(c.id, e.target.files[0], s.id)
                                    e.target.value = ''
                                  }}
                                />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </main>
  )
}
