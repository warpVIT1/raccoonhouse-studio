import React, { useEffect, useState, useRef, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { EpisodeBadge } from './ui/Badge'
import { ProgressBar } from './ui/ProgressBar'
import { Spinner } from './ui/Spinner'
import { PosterSearch } from './PosterSearch'
import type { Title, Episode, JobStatus, HikkaAnimeResult } from '../types'

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—'
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '—'
  const gb = bytes / 1e9
  if (gb >= 1) return `${gb.toFixed(1)} ГБ`
  return `${(bytes / 1e6).toFixed(0)} МБ`
}

function episodeStatusProgress(status: Episode['status']): number {
  const map: Record<Episode['status'], number> = {
    not_uploaded: 0, processing: 30, vocal_isolated: 60, marked: 80, ready: 100,
  }
  return map[status]
}

interface PendingImport {
  file: File
  season: number
  number: number
}

interface TitlePageProps {
  titleId: number
}

export function TitlePage({ titleId }: TitlePageProps) {
  const { get, post, put, del } = useApi()
  const backendReady = useAppStore((s) => s.backendReady)
  const setSelectedEpisode = useAppStore((s) => s.setSelectedEpisode)
  const setSelectedTitle = useAppStore((s) => s.setSelectedTitle)
  const activeJobs = useAppStore((s) => s.activeJobs)
  const upsertJob = useAppStore((s) => s.upsertJob)

  const [title, setTitle] = useState<Title | null>(null)
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<PendingImport[] | null>(null)
  const [showPosterModal, setShowPosterModal] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!backendReady) return
    setLoading(true)
    Promise.all([
      get<Title>(`/titles/${titleId}`),
      get<Episode[]>(`/titles/${titleId}/episodes`),
    ])
      .then(([t, eps]) => {
        setTitle(t)
        setEpisodes(eps)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [backendReady, titleId, get])

  // Live-refresh: when a background job for one of this title's episodes
  // finishes, refetch that episode so its tile updates (status, duration,
  // subtitle count...) without needing to leave and re-enter the title.
  const handledJobIdsRef = useRef(new Set<string>())
  useEffect(() => {
    if (!backendReady) return
    for (const job of activeJobs.values()) {
      if (job.status !== 'complete' || !job.episode_id) continue
      if (!episodes.some((e) => e.id === job.episode_id)) continue
      if (handledJobIdsRef.current.has(job.id)) continue
      handledJobIdsRef.current.add(job.id)

      get<Episode>(`/episodes/${job.episode_id}`)
        .then((updated) => setEpisodes((prev) => prev.map((e) => (e.id === updated.id ? updated : e))))
        .catch(() => {})
    }
  }, [activeJobs, backendReady, episodes, get])

  const handleFileDrop = useCallback((files: FileList) => {
    const videoFiles = Array.from(files).filter((f) =>
      /\.(mkv|mp4|avi|mov|m2ts|ts)$/i.test(f.name)
    )
    if (videoFiles.length === 0) return

    // Guess episode numbers from filenames as a starting point — the user
    // reviews and can override every value before anything is imported.
    let nextGuess = episodes.length + 1
    const items: PendingImport[] = videoFiles.map((file) => {
      const epMatch = file.name.match(/[Ee](?:p(?:isode)?)?\.?0*(\d+)/i)
      const number = epMatch ? parseInt(epMatch[1], 10) : nextGuess++
      return { file, season: 1, number }
    })
    setPendingFiles(items)
  }, [episodes.length])

  const confirmImport = useCallback(async (items: PendingImport[]) => {
    setPendingFiles(null)
    setImporting(true)
    for (const { file, season, number } of items) {
      try {
        if (backendReady) {
          const result = await post<{ job_id: string; episode: Episode }>(
            `/titles/${titleId}/import-video`,
            { file_path: (file as File & { path?: string }).path ?? file.name, episode_number: number, season }
          )
          upsertJob({
            id: result.job_id,
            type: 'import_video',
            status: 'running',
            percent: 0,
            message: `Імпорт ${file.name}…`,
            episode_id: result.episode.id,
          })
          setEpisodes((prev) => {
            const existing = prev.findIndex((e) => e.id === result.episode.id)
            if (existing >= 0) {
              const updated = [...prev]
              updated[existing] = result.episode
              return updated
            }
            return [...prev, result.episode].sort((a, b) => a.number - b.number)
          })
        }
      } catch {
        // ignore individual import errors
      }
    }
    setImporting(false)
  }, [backendReady, post, titleId, upsertJob])

  const renumberEpisode = useCallback(async (epId: number, season: number, number: number) => {
    if (!backendReady) {
      setEpisodes((prev) => prev.map((e) => (e.id === epId ? { ...e, season, number } : e)).sort((a, b) => a.number - b.number))
      return
    }
    try {
      const updated = await put<Episode>(`/episodes/${epId}`, { season, number })
      setEpisodes((prev) => prev.map((e) => (e.id === epId ? updated : e)).sort((a, b) => a.number - b.number))
    } catch {
      // ignore — keep old value
    }
  }, [backendReady, put])

  const changeEpisodeStatus = useCallback(async (epId: number, status: Episode['status']) => {
    if (!backendReady) {
      setEpisodes((prev) => prev.map((e) => (e.id === epId ? { ...e, status } : e)))
      return
    }
    try {
      const updated = await put<Episode>(`/episodes/${epId}`, { status })
      setEpisodes((prev) => prev.map((e) => (e.id === epId ? updated : e)))
    } catch {
      // ignore
    }
  }, [backendReady, put])

  const deleteEpisode = useCallback(async (epId: number) => {
    if (backendReady) {
      try {
        await del(`/episodes/${epId}`)
      } catch {
        return
      }
    }
    setEpisodes((prev) => prev.filter((e) => e.id !== epId))
  }, [backendReady, del])

  function onDragOver(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(true)
  }
  function onDragLeave() { setDragOver(false) }
  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) handleFileDrop(e.dataTransfer.files)
  }

  const titleData = title ?? { name_ua: 'Тайтл', name_original: '', id: titleId, status: 'new' as const, poster_path: null }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-rh-border flex-shrink-0">
        <button
          onClick={() => setSelectedTitle(null)}
          className="rh-btn-ghost px-2 py-1.5"
        >
          ← Всі тайтли
        </button>
        <div className="w-px h-5 bg-rh-border" />
        <div>
          <h1 className="text-base font-semibold text-rh-text">{titleData.name_ua}</h1>
          {titleData.name_original && (
            <p className="text-xs text-rh-muted">{titleData.name_original}</p>
          )}
        </div>
        <button
          onClick={() => setShowPosterModal(true)}
          className="rh-btn-ghost px-2 py-1.5 text-xs"
        >
          Змінити постер
        </button>

        <div className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 border border-rh-border px-3 py-1 text-xs text-rh-muted">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />
            Автостиснення в 480p для перегляду, оригінал зберігається
          </span>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rh-btn-outline"
            disabled={importing}
          >
            {importing ? <Spinner size={14} /> : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
            )}
            Імпорт відео
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mkv,.mp4,.avi,.mov,.m2ts,.ts"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) handleFileDrop(e.target.files) }}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {/* Episode grid */}
        {loading ? (
          <div className="flex justify-center py-16"><Spinner size={24} className="text-rh-accent" /></div>
        ) : episodes.length === 0 ? (
          <div className="rh-card text-center py-7 px-5">
            <div className="text-sm font-semibold mb-1">Ще немає серій</div>
            <div className="text-xs text-rh-muted">Додайте першу серію, щоб почати обробку.</div>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {episodes.map((ep) => {
              const epJob = [...activeJobs.values()].find(
                (j) => j.episode_id === ep.id && j.status === 'running'
              )
              return (
                <EpisodeTile
                  key={ep.id}
                  episode={ep}
                  job={epJob}
                  onClick={() => setSelectedEpisode(ep.id)}
                  onRenumber={(season, number) => renumberEpisode(ep.id, season, number)}
                  onStatusChange={(status) => changeEpisodeStatus(ep.id, status)}
                  onDelete={() => deleteEpisode(ep.id)}
                />
              )
            })}
          </div>
        )}

        {/* Drop zone */}
        <div
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 transition-all duration-150 cursor-pointer
            ${dragOver
              ? 'border-rh-accent bg-rh-accent/5'
              : 'border-rh-border hover:border-rh-border2'
            }`}
        >
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${dragOver ? 'bg-rh-accent/20' : 'bg-rh-card2'}`}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={dragOver ? '#E52128' : '#6B6B7A'} strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div className="text-center">
            <p className={`text-sm font-medium ${dragOver ? 'text-rh-accent' : 'text-rh-text-dim'}`}>
              Перетягніть відео сюди<br />або натисніть, щоб обрати файл
            </p>
            <p className="text-xs text-rh-muted mt-1">
              Без обмежень по розміру файлу
            </p>
          </div>
        </div>
      </div>

      {pendingFiles && (
        <ImportReviewModal
          items={pendingFiles}
          onCancel={() => setPendingFiles(null)}
          onConfirm={confirmImport}
        />
      )}

      {showPosterModal && (
        <PosterModal
          titleId={titleId}
          defaultQuery={titleData.name_original || titleData.name_ua}
          onClose={() => setShowPosterModal(false)}
          onSaved={(t) => { setTitle(t); setShowPosterModal(false) }}
        />
      )}
    </div>
  )
}

interface PosterModalProps {
  titleId: number
  defaultQuery: string
  onClose: () => void
  onSaved: (title: Title) => void
}
function PosterModal({ titleId, defaultQuery, onClose, onSaved }: PosterModalProps) {
  const { post } = useApi()
  const [selected, setSelected] = useState<HikkaAnimeResult | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    if (!selected?.image) return
    setSaving(true)
    try {
      const updated = await post<Title>(`/titles/${titleId}/poster-from-url`, { image_url: selected.image })
      onSaved(updated)
    } catch {
      // ignore — keep modal open so the user can retry
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="rh-card w-[440px] max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold">Постер тайтлу</h2>
        <PosterSearch defaultQuery={defaultQuery} selected={selected} onSelect={setSelected} />
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="rh-btn-ghost">Скасувати</button>
          <button onClick={handleSave} className="rh-btn-primary" disabled={saving || !selected}>
            {saving ? <Spinner size={14} /> : null}
            Зберегти
          </button>
        </div>
      </div>
    </div>
  )
}

interface ImportReviewModalProps {
  items: PendingImport[]
  onCancel: () => void
  onConfirm: (items: PendingImport[]) => void
}
function ImportReviewModal({ items, onCancel, onConfirm }: ImportReviewModalProps) {
  const [rows, setRows] = useState(items)

  function update(idx: number, patch: Partial<PendingImport>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="rh-card w-[520px] max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-base font-semibold">Номери серій</h2>
          <p className="text-xs text-rh-muted mt-1">Перевірте або змініть сезон і номер серії перед імпортом.</p>
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2.5 rounded-lg border border-rh-border px-3 py-2">
              <span className="text-xs text-rh-text-dim flex-1 truncate">{row.file.name}</span>
              <label className="text-[10.5px] text-rh-muted">Сезон</label>
              <input
                type="number"
                min={1}
                value={row.season}
                onChange={(e) => update(idx, { season: Math.max(1, Number(e.target.value) || 1) })}
                className="rh-input w-14 text-center px-1"
              />
              <label className="text-[10.5px] text-rh-muted">Серія</label>
              <input
                type="number"
                min={1}
                value={row.number}
                onChange={(e) => update(idx, { number: Math.max(1, Number(e.target.value) || 1) })}
                className="rh-input w-16 text-center px-1"
              />
            </div>
          ))}
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="rh-btn-ghost">Скасувати</button>
          <button onClick={() => onConfirm(rows)} className="rh-btn-primary">Імпортувати</button>
        </div>
      </div>
    </div>
  )
}

const STATUS_OPTIONS: Array<{ value: Episode['status']; label: string }> = [
  { value: 'not_uploaded', label: 'Не завантажено' },
  { value: 'processing', label: 'Обробка' },
  { value: 'vocal_isolated', label: 'Голос вирізано' },
  { value: 'marked', label: 'Промарковано' },
  { value: 'ready', label: 'Готово' },
]

interface EpisodeTileProps {
  episode: Episode
  job?: JobStatus
  onClick: () => void
  onRenumber: (season: number, number: number) => void
  onStatusChange: (status: Episode['status']) => void
  onDelete: () => void
}
function EpisodeTile({ episode, job, onClick, onRenumber, onStatusChange, onDelete }: EpisodeTileProps) {
  const progress = job ? job.percent : episodeStatusProgress(episode.status)
  const isProcessing = Boolean(job && job.status === 'running')
  const canOpen = episode.status !== 'not_uploaded'
  const [menuOpen, setMenuOpen] = useState(false)
  const [renumbering, setRenumbering] = useState(false)
  const [changingStatus, setChangingStatus] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [seasonInput, setSeasonInput] = useState(episode.season)
  const [numberInput, setNumberInput] = useState(episode.number)

  return (
    <div
      onClick={() => { if (canOpen && !menuOpen) onClick() }}
      className={`rh-card p-4 flex flex-col gap-3 text-left transition-all duration-150 relative
        ${canOpen ? 'hover:border-rh-border2 cursor-pointer' : 'opacity-50 cursor-default'}`}
    >
      {/* Episode number + menu */}
      <div className="flex items-start gap-2">
        {renumbering ? (
          <div className="flex items-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex flex-col gap-0.5">
              <label className="font-mono text-[9px] tracking-widest text-rh-muted">СЕЗОН</label>
              <input
                type="number"
                min={1}
                autoFocus
                value={seasonInput}
                onChange={(e) => setSeasonInput(Math.max(1, Number(e.target.value) || 1))}
                className="rh-input w-12 px-1 py-0.5 text-sm"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label className="font-mono text-[9px] tracking-widest text-rh-muted">СЕРІЯ</label>
              <input
                type="number"
                min={1}
                value={numberInput}
                onChange={(e) => setNumberInput(Math.max(1, Number(e.target.value) || 1))}
                className="rh-input w-14 px-1 py-0.5 text-sm"
              />
            </div>
            <button
              onClick={() => { onRenumber(seasonInput, numberInput); setRenumbering(false) }}
              className="text-[10.5px] text-rh-accent hover:text-rh-accent-h px-1 py-1"
            >
              ✓
            </button>
            <button
              onClick={() => { setSeasonInput(episode.season); setNumberInput(episode.number); setRenumbering(false) }}
              className="text-[10.5px] text-rh-muted hover:text-white px-1 py-1"
            >
              ✕
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[9.5px] tracking-widest text-rh-muted">СЕРІЯ</span>
            <span className="text-xl font-semibold text-rh-text leading-none">
              {String(episode.number).padStart(2, '0')}
            </span>
          </div>
        )}
        <div className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v) }}
          className="w-[26px] h-[26px] rounded-lg border border-transparent hover:border-rh-border hover:bg-white/5 text-rh-muted hover:text-rh-text flex items-center justify-center flex-shrink-0"
        >
          ⋯
        </button>
        {menuOpen && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-2.5 top-10 z-40 bg-[#1B1B1F] border border-rh-border2 rounded-xl p-1 min-w-[150px] shadow-2xl flex flex-col"
          >
            <button
              onClick={() => { setMenuOpen(false); onClick() }}
              className="text-left rounded-lg px-2.5 py-1.5 text-xs text-rh-text hover:bg-white/5"
            >
              Відкрити
            </button>
            <button
              onClick={() => { setMenuOpen(false); setRenumbering(true) }}
              className="text-left rounded-lg px-2.5 py-1.5 text-xs text-rh-text hover:bg-white/5"
            >
              Змінити номер
            </button>
            <button
              onClick={() => { setMenuOpen(false); setChangingStatus(true) }}
              className="text-left rounded-lg px-2.5 py-1.5 text-xs text-rh-text hover:bg-white/5"
            >
              Змінити статус
            </button>
            <button
              onClick={() => { setMenuOpen(false); setConfirmingDelete(true) }}
              className="text-left rounded-lg px-2.5 py-1.5 text-xs text-red-400 hover:bg-rh-accent/10"
            >
              Видалити
            </button>
          </div>
        )}

        {changingStatus && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute right-2.5 top-10 z-40 bg-[#1B1B1F] border border-rh-border2 rounded-xl p-1 min-w-[170px] shadow-2xl flex flex-col"
          >
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => { onStatusChange(opt.value); setChangingStatus(false) }}
                className={`text-left rounded-lg px-2.5 py-1.5 text-xs hover:bg-white/5 ${opt.value === episode.status ? 'text-rh-accent font-semibold' : 'text-rh-text'}`}
              >
                {opt.label}
              </button>
            ))}
            <button
              onClick={() => setChangingStatus(false)}
              className="text-left rounded-lg px-2.5 py-1.5 text-xs text-rh-muted hover:bg-white/5 border-t border-rh-border mt-1 pt-1.5"
            >
              Скасувати
            </button>
          </div>
        )}

        {confirmingDelete && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-0 z-50 bg-black/85 rounded-2xl flex flex-col items-center justify-center gap-2.5 p-3 text-center"
          >
            <span className="text-xs text-white">Видалити серію {String(episode.number).padStart(2, '0')}?</span>
            <div className="flex gap-2">
              <button onClick={() => setConfirmingDelete(false)} className="rh-btn-ghost text-[11px] px-2 py-1">Скасувати</button>
              <button onClick={onDelete} className="bg-rh-accent hover:bg-rh-accent-h text-white text-[11px] px-2 py-1 rounded-md font-semibold">Видалити</button>
            </div>
          </div>
        )}
      </div>

      {/* Status */}
      <div>
        {isProcessing ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 text-amber-300 text-[10.5px] font-semibold pl-1 pr-2.5 py-0.5">
            <Spinner size={11} />
            {job?.message || 'Обробка...'} {job ? `${job.percent}%` : ''}
          </span>
        ) : (
          <EpisodeBadge status={episode.status} />
        )}
      </div>

      {/* Progress bar */}
      <ProgressBar
        percent={progress}
        color={isProcessing ? 'bg-amber-400' : 'bg-rh-accent'}
      />

      {/* Metadata */}
      <div className="flex items-center justify-between text-xs text-rh-muted font-mono">
        <span>{formatDuration(episode.duration)}</span>
        <span>{formatSize(episode.original_size)}</span>
      </div>

      {/* Subtitle count */}
      {episode.subtitle_count != null && episode.subtitle_count > 0 && (
        <div className="text-xs text-rh-muted">
          {episode.subtitle_count} рядків
        </div>
      )}
    </div>
  )
}
