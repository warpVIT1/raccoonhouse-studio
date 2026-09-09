import React, { useEffect, useRef, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { Spinner } from './ui/Spinner'
import type { Episode } from '../types'

interface CleanerWorkspaceProps {
  episodeId: number
  titleId: number
}

// The "cleaner" (клінапер) role's own workspace: download the raw original
// video, upload back the cleaned (signs/on-screen text erased) result.
// Deliberately minimal — no subtitle/marker editing, that's not their job.
export function CleanerWorkspace({ episodeId }: CleanerWorkspaceProps) {
  const { get, post } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const activeJobs = useAppStore((s) => s.activeJobs)
  const upsertJob = useAppStore((s) => s.upsertJob)
  const [episode, setEpisode] = useState<Episode | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const loadEpisode = React.useCallback(() => {
    if (!backendReady) return
    get<Episode>(`/episodes/${episodeId}`).then(setEpisode).catch(() => {})
  }, [backendReady, episodeId, get])
  useEffect(() => { loadEpisode() }, [loadEpisode])

  // Same on-demand pull as DirectorWorkspace/TranslatorWorkspace/
  // EpisodeWorkspace — the raw original sits in R2 until asked for.
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
      /* ignore — best-effort, same posture as every other job trigger here */
    } finally {
      setDownloadingOriginal(false)
    }
  }
  const downloadingOriginalJob = [...activeJobs.values()].find(
    (j) => j.episode_id === episodeId && j.type === 'download_original_video' && j.status === 'running'
  )

  async function handleUploadCleaned(files: FileList) {
    const file = files[0] as File & { path?: string }
    if (!file?.path) return
    try {
      const result = await post<{ job_id: string }>(`/episodes/${episodeId}/cleaned-video`, { file_path: file.path })
      upsertJob({
        id: result.job_id, type: 'submit_cleaned_video', status: 'running', percent: 0,
        message: `Завантажую ${file.name}…`, episode_id: episodeId, filename: file.name,
      })
    } catch {
      /* ignore — best-effort per file, same posture as actor-audio submit */
    }
  }
  const uploadingCleanedJob = [...activeJobs.values()].find(
    (j) => j.episode_id === episodeId && j.type === 'submit_cleaned_video' && j.status === 'running'
  )

  // Refetch episode once an upload completes so the "завантажено" status
  // line below picks up the new cleaned_video_filename.
  const handledJobIdsRef = useRef(new Set<string>())
  useEffect(() => {
    for (const job of activeJobs.values()) {
      if (job.type !== 'submit_cleaned_video' || job.episode_id !== episodeId) continue
      if (job.status !== 'complete') continue
      if (handledJobIdsRef.current.has(job.id)) continue
      handledJobIdsRef.current.add(job.id)
      loadEpisode()
    }
  }, [activeJobs, episodeId, loadEpisode])

  return (
    <div className="h-full overflow-y-auto p-6 flex flex-col gap-4 max-w-xl">
      <div>
        <div className="text-[15px] font-bold">Клінапер</div>
        <div className="text-[11px] text-rh-muted mt-0.5">
          Серія {episode?.number ?? '…'} — скачайте оригінал, заклінапте, завантажте результат
        </div>
      </div>

      <div className="bg-rh-card border border-rh-border rounded-2xl p-4 flex flex-col gap-2">
        <div className="text-[12.5px] font-bold">Оригінальне відео</div>
        {episode?.original_file_path ? (
          <div className="text-[11px] text-rh-muted">Вже на цьому пристрої</div>
        ) : episode?.remote_video_transfer_id ? (
          <button
            onClick={handleDownloadOriginal}
            disabled={!backendReady || downloadingOriginal || !!downloadingOriginalJob}
            className="rh-btn-primary text-xs flex items-center gap-1.5 disabled:opacity-50 self-start"
          >
            {downloadingOriginalJob ? (
              <>
                <Spinner size={12} />
                {downloadingOriginalJob.percent}%
              </>
            ) : 'Скачати оригінал'}
          </button>
        ) : (
          <div className="text-[11px] text-rh-muted">Оригінал ще не завантажено в хмару</div>
        )}
      </div>

      <div className="bg-rh-card border border-rh-border rounded-2xl p-4 flex flex-col gap-2">
        <div className="text-[12.5px] font-bold">Заклінапене відео</div>
        {episode?.cleaned_video_filename && (
          <div className="text-[11px] text-emerald-400">
            ✓ Завантажено — {episode.cleaned_video_filename}
            {episode.cleaned_video_uploaded_at && ` (${new Date(episode.cleaned_video_uploaded_at).toLocaleString()})`}
          </div>
        )}
        {uploadingCleanedJob && (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center justify-between text-[10.5px] text-rh-muted font-mono">
              <span className="truncate">{uploadingCleanedJob.filename ?? '…'}</span>
              <span className="flex-shrink-0 ml-2">{uploadingCleanedJob.percent}%</span>
            </div>
            <div className="h-1 rounded-full bg-rh-bg overflow-hidden">
              <div className="h-full bg-rh-accent transition-all" style={{ width: `${uploadingCleanedJob.percent}%` }} />
            </div>
          </div>
        )}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={!!uploadingCleanedJob}
          className="rh-btn-primary text-xs self-start disabled:opacity-60"
        >
          {episode?.cleaned_video_filename ? 'Завантажити інше відео' : 'Завантажити заклінапене відео'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => { if (e.target.files?.length) handleUploadCleaned(e.target.files); e.target.value = '' }}
        />
      </div>
    </div>
  )
}
