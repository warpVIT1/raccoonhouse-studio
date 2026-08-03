import React, { useEffect, useMemo, useState } from 'react'
import { useApi } from '../hooks/useApi'
import { useAppStore } from '../stores/appStore'
import { Spinner } from './ui/Spinner'
import { useBackdropClose } from '../hooks/useBackdropClose'
import type { RegistryEntry, ModelRating, CatalogModel, ModelProposal } from '../types'

const METHODS = ['MDX-Net', 'VR Arch', 'Demucs', 'MDX23C', 'BS-RoFormer'] as const
const ARCHS = ['mdx', 'vr', 'demucs', 'mdxc'] as const

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

// Full audio-separator registry browser, PLUS a shared "add by URL" catalog
// (see backend/routers/model_browser.py) — pasting a model repository link
// hands it to a Cloudflare Workers AI model that figures out the
// architecture/checkpoint/config on its own (see cloudflare-signaling's
// /models/auto-configure), so adding a model no longer requires knowing its
// exact registry filename by hand the way the old "Власні моделі" did.
// Everything here — the catalog and the star ratings — is shared studio-wide
// via Cloudflare D1, not stored per-install. A top-level sidebar tab (like
// Тайтли/Налаштування), not a modal — the previous popup version made it
// feel like a one-off dialog rather than a place worth browsing.
export function ModelBrowserPage() {
  const { get, post, del } = useApi()
  const activeProfile = useAppStore((s) => s.activeProfile)
  const activeJobs = useAppStore((s) => s.activeJobs)
  const upsertJob = useAppStore((s) => s.upsertJob)
  const isAdmin = !!activeProfile?.is_admin

  const [method, setMethod] = useState<(typeof METHODS)[number]>('BS-RoFormer')
  const [search, setSearch] = useState('')
  const [onlyDownloaded, setOnlyDownloaded] = useState(false)
  const [entries, setEntries] = useState<RegistryEntry[] | null>(null)
  const [catalog, setCatalog] = useState<CatalogModel[] | null>(null)
  const [ratings, setRatings] = useState<ModelRating[]>([])
  const [downloaded, setDownloaded] = useState<Set<string>>(new Set())
  const [downloadJobs, setDownloadJobs] = useState<Record<string, string>>({}) // filename -> job_id
  const [error, setError] = useState<string | null>(null)

  const [detail, setDetail] = useState<
    { kind: 'registry'; entry: RegistryEntry } | { kind: 'catalog'; item: CatalogModel } | null
  >(null)
  const detailBackdrop = useBackdropClose(() => setDetail(null))

  const [addingByUrl, setAddingByUrl] = useState(false)
  const [submitUrl, setSubmitUrl] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [proposal, setProposal] = useState<ModelProposal | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  function loadCatalog() {
    get<CatalogModel[]>(`/models/catalog?method=${encodeURIComponent(method)}`).then(setCatalog).catch(() => setCatalog([]))
  }

  function loadDownloaded() {
    get<{ filenames: string[] }>('/models/downloaded')
      .then((r) => setDownloaded(new Set(r.filenames)))
      .catch(() => {})
  }

  useEffect(() => {
    setEntries(null)
    setError(null)
    get<RegistryEntry[]>(`/models/browse?method=${encodeURIComponent(method)}`)
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : 'Не вдалося отримати список моделей'))
    get<ModelRating[]>(`/models/ratings?method=${encodeURIComponent(method)}`)
      .then(setRatings)
      .catch(() => {})
    loadCatalog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, get])

  useEffect(() => {
    loadDownloaded()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get])

  // Once a tracked download job completes, drop it from the in-flight map
  // and refresh the on-disk list so that row flips to "Завантажено".
  useEffect(() => {
    const entriesToDrop: string[] = []
    for (const [filename, jobId] of Object.entries(downloadJobs)) {
      const job = activeJobs.get(jobId)
      if (job && (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled')) {
        entriesToDrop.push(filename)
        if (job.status === 'complete') {
          setDownloaded((prev) => new Set(prev).add(filename))
        }
      }
    }
    if (entriesToDrop.length) {
      setDownloadJobs((prev) => {
        const next = { ...prev }
        for (const f of entriesToDrop) delete next[f]
        return next
      })
    }
  }, [activeJobs, downloadJobs])

  async function downloadRegistryModel(filename: string) {
    setError(null)
    try {
      const result = await post<{ job_id: string }>('/models/download', { method, filename })
      setDownloadJobs((prev) => ({ ...prev, [filename]: result.job_id }))
      upsertJob({ id: result.job_id, type: 'download_model', status: 'running', percent: 0, message: `Завантаження ${filename}…` })
    } catch (e) {
      setError(extractApiError(e, 'Не вдалося почати завантаження'))
    }
  }

  async function downloadCatalogModel(item: CatalogModel) {
    setError(null)
    try {
      const result = await post<{ job_id: string }>('/models/download', {
        method: item.method, filename: item.filename, source: 'custom',
        label: item.label, arch: item.arch, download_url: item.download_url, config_yaml_url: item.config_yaml_url,
      })
      setDownloadJobs((prev) => ({ ...prev, [item.filename]: result.job_id }))
      upsertJob({ id: result.job_id, type: 'download_model', status: 'running', percent: 0, message: `Завантаження ${item.filename}…` })
    } catch (e) {
      setError(extractApiError(e, 'Не вдалося почати завантаження'))
    }
  }

  // Removes THIS install's own downloaded file — never the shared catalog
  // entry itself (that has its own separate ✕, admin/owner-gated — see the
  // catalog rows below). Just frees up disk space / clears a bad download.
  async function deleteDownloaded(filename: string) {
    setError(null)
    try {
      await del(`/models/downloaded/${encodeURIComponent(filename)}`)
      setDownloaded((prev) => {
        const next = new Set(prev)
        next.delete(filename)
        return next
      })
    } catch (e) {
      setError(extractApiError(e, 'Не вдалося видалити завантажену модель'))
    }
  }

  async function rate(filename: string, value: number) {
    if (!activeProfile) {
      setError('Оберіть профіль, щоб оцінювати моделі')
      return
    }
    setRatings((prev) => [
      ...prev.filter((r) => !(r.filename === filename && r.profile_name === activeProfile.name)),
      { method, filename, profile_name: activeProfile.name, rating: value },
    ])
    try {
      await post('/models/ratings', { method, filename, rating: value })
    } catch (e) {
      setError(extractApiError(e, 'Не вдалося зберегти оцінку'))
    }
  }

  async function analyzeUrl() {
    const url = submitUrl.trim()
    if (!url) return
    setAnalyzing(true)
    setSubmitError(null)
    setProposal(null)
    try {
      const result = await post<ModelProposal>('/models/submit', { url })
      setProposal(result)
      if ((METHODS as readonly string[]).includes(result.method)) {
        setMethod(result.method as (typeof METHODS)[number])
      }
    } catch (e) {
      setSubmitError(extractApiError(e, 'Не вдалося проаналізувати посилання'))
    } finally {
      setAnalyzing(false)
    }
  }

  async function confirmProposal() {
    if (!proposal) return
    if (!proposal.download_url) {
      setSubmitError('Немає посилання для завантаження — вкажіть його вручну або спробуйте інший URL')
      return
    }
    setConfirming(true)
    setSubmitError(null)
    try {
      await post('/models/confirm', {
        method: proposal.method,
        filename: proposal.filename,
        label: proposal.label,
        arch: proposal.arch,
        download_url: proposal.download_url,
        config_yaml_url: proposal.config_yaml_url,
        source_url: proposal.source_url,
      })
      setProposal(null)
      setSubmitUrl('')
      setAddingByUrl(false)
      loadCatalog()
    } catch (e) {
      setSubmitError(extractApiError(e, 'Не вдалося зберегти модель'))
    } finally {
      setConfirming(false)
    }
  }

  async function removeCatalogModel(id: string) {
    try {
      await del(`/models/catalog/${id}`)
      setCatalog((prev) => prev?.filter((c) => c.id !== id) ?? null)
    } catch (e) {
      setError(extractApiError(e, 'Не вдалося видалити модель'))
    }
  }

  const filteredEntries = useMemo(() => {
    if (!entries) return null
    const q = search.trim().toLowerCase()
    const filtered = entries.filter((e) => {
      if (onlyDownloaded && !downloaded.has(e.filename)) return false
      if (!q) return true
      return e.label.toLowerCase().includes(q) || e.filename.toLowerCase().includes(q)
    })
    // Actively-downloading rows float to the top — otherwise a model started
    // from further down the list needs scrolling to confirm it's progressing.
    return [...filtered].sort((a, b) => (downloadJobs[b.filename] ? 1 : 0) - (downloadJobs[a.filename] ? 1 : 0))
  }, [entries, search, onlyDownloaded, downloaded, downloadJobs])

  const filteredCatalog = useMemo(() => {
    if (!catalog) return null
    const q = search.trim().toLowerCase()
    const filtered = catalog.filter((c) => {
      if (onlyDownloaded && !downloaded.has(c.filename)) return false
      if (!q) return true
      return c.label.toLowerCase().includes(q) || c.filename.toLowerCase().includes(q)
    })
    return [...filtered].sort((a, b) => (downloadJobs[b.filename] ? 1 : 0) - (downloadJobs[a.filename] ? 1 : 0))
  }, [catalog, search, onlyDownloaded, downloaded, downloadJobs])

  function ratingsFor(filename: string) {
    const forModel = ratings.filter((r) => r.filename === filename)
    const mine = forModel.find((r) => r.profile_name === activeProfile?.name)?.rating ?? 0
    const avg = forModel.length ? forModel.reduce((s, r) => s + r.rating, 0) / forModel.length : 0
    return { mine, avg, count: forModel.length, all: forModel }
  }

  function downloadState(filename: string) {
    const isDownloaded = downloaded.has(filename)
    const jobId = downloadJobs[filename]
    const job = jobId ? activeJobs.get(jobId) : undefined
    const isDownloading = !!job && job.status === 'running'
    return { isDownloaded, isDownloading, percent: job?.percent ?? 0 }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-rh-border flex-shrink-0">
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-black">Браузер моделей</h1>
          <div className="text-[11px] text-rh-text-dim mt-0.5">
            Реєстр audio-separator і додані спільнотою моделі — завантажуйте й оцінюйте, оцінки видно всій студії
          </div>
        </div>
        <button
          onClick={() => { setAddingByUrl((v) => !v); setSubmitError(null) }}
          className="rh-btn-outline text-[11px] px-3 flex-shrink-0"
        >
          {addingByUrl ? 'Скасувати' : '+ Додати за посиланням'}
        </button>
      </div>

      <div className="px-6 pt-4 flex gap-1.5 flex-wrap flex-shrink-0">
        {METHODS.map((m) => (
          <button
            key={m}
            onClick={() => setMethod(m)}
            className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-colors ${
              method === m
                ? 'bg-rh-accent/15 border-rh-accent/50 text-white'
                : 'border-rh-border text-rh-text-dim hover:border-rh-accent/40 hover:text-white'
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="px-6 pt-3 flex gap-2 flex-shrink-0">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Пошук за назвою або файлом…"
          className="rh-input flex-1 text-xs max-w-[420px]"
        />
        <button
          onClick={() => setOnlyDownloaded(false)}
          className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-colors flex-shrink-0 ${
            !onlyDownloaded
              ? 'bg-rh-accent/15 border-rh-accent/50 text-white'
              : 'border-rh-border text-rh-text-dim hover:border-rh-accent/40 hover:text-white'
          }`}
        >
          Всі моделі
        </button>
        <button
          onClick={() => setOnlyDownloaded(true)}
          className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-colors flex-shrink-0 ${
            onlyDownloaded
              ? 'bg-rh-accent/15 border-rh-accent/50 text-white'
              : 'border-rh-border text-rh-text-dim hover:border-rh-accent/40 hover:text-white'
          }`}
        >
          Свої моделі
        </button>
      </div>

      {addingByUrl && (
        <div className="mx-6 mt-3 flex flex-col gap-2 border border-rh-border rounded-lg px-3 py-3 flex-shrink-0">
          <p className="text-[10.5px] text-rh-muted leading-snug">
            Вставте посилання на репозиторій моделі (HuggingFace або GitHub) — нейромережа сама визначить
            архітектуру, файл моделі й конфігурацію. Перевірте результат перед підтвердженням.
          </p>
          <div className="flex gap-2 max-w-[600px]">
            <input
              value={submitUrl}
              onChange={(e) => setSubmitUrl(e.target.value)}
              placeholder="https://huggingface.co/owner/repo"
              autoComplete="off"
              className="rh-input flex-1 text-[12px] font-mono"
            />
            <button
              onClick={analyzeUrl}
              disabled={analyzing || !submitUrl.trim()}
              className="rh-btn-primary text-[11px] px-3 flex-shrink-0"
            >
              {analyzing ? <Spinner size={11} /> : null}
              Аналізувати
            </button>
          </div>
          {submitError && <span className="text-[11px] text-[#FF6B70]">{submitError}</span>}

          {proposal && (
            <div className="flex flex-col gap-2 mt-1 border-t border-rh-border/70 pt-2.5 max-w-[600px]">
              <div className="flex items-center gap-2">
                <span className="text-[10.5px] text-rh-muted">Впевненість ІІ:</span>
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  proposal.confidence === 'high' ? 'text-emerald-400 bg-emerald-400/10' :
                  proposal.confidence === 'medium' ? 'text-amber-400 bg-amber-400/10' : 'text-[#FF6B70] bg-[#FF6B70]/10'
                }`}>
                  {proposal.confidence}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[10.5px] text-rh-muted">
                  Метод
                  <select
                    value={proposal.method}
                    onChange={(e) => setProposal({ ...proposal, method: e.target.value })}
                    className="rh-input text-[12px]"
                  >
                    {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-[10.5px] text-rh-muted">
                  Архітектура
                  <select
                    value={proposal.arch}
                    onChange={(e) => setProposal({ ...proposal, arch: e.target.value })}
                    className="rh-input text-[12px]"
                  >
                    {ARCHS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </label>
              </div>

              <label className="flex flex-col gap-1 text-[10.5px] text-rh-muted">
                Назва для показу
                <input
                  value={proposal.label}
                  onChange={(e) => setProposal({ ...proposal, label: e.target.value })}
                  className="rh-input text-[12px]"
                />
              </label>

              <label className="flex flex-col gap-1 text-[10.5px] text-rh-muted">
                Файл моделі
                <input
                  value={proposal.filename}
                  onChange={(e) => setProposal({ ...proposal, filename: e.target.value })}
                  className="rh-input text-[12px] font-mono"
                />
              </label>

              <label className="flex flex-col gap-1 text-[10.5px] text-rh-muted">
                Посилання на завантаження
                {!proposal.download_url_ok && (
                  <span className="text-[10px] text-amber-400">⚠ посилання не перевірено — перегляньте вручну</span>
                )}
                <input
                  value={proposal.download_url ?? ''}
                  onChange={(e) => setProposal({ ...proposal, download_url: e.target.value })}
                  className={`rh-input text-[11px] font-mono ${!proposal.download_url_ok ? 'border-amber-400/60' : ''}`}
                />
              </label>

              <label className="flex flex-col gap-1 text-[10.5px] text-rh-muted">
                Посилання на конфіг (yaml, якщо потрібен)
                {proposal.config_yaml_url && !proposal.config_yaml_url_ok && (
                  <span className="text-[10px] text-amber-400">⚠ посилання не перевірено — перегляньте вручну</span>
                )}
                <input
                  value={proposal.config_yaml_url ?? ''}
                  onChange={(e) => setProposal({ ...proposal, config_yaml_url: e.target.value || null })}
                  className={`rh-input text-[11px] font-mono ${proposal.config_yaml_url && !proposal.config_yaml_url_ok ? 'border-amber-400/60' : ''}`}
                />
              </label>

              <button
                onClick={confirmProposal}
                disabled={confirming}
                className="rh-btn-primary text-[11px] self-start px-3 py-1.5"
              >
                {confirming ? <Spinner size={11} /> : null}
                Підтвердити і додати в каталог
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="px-6 pt-3 text-[11px] text-[#FF6B70] flex-shrink-0">{error}</div>}

      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-4">
        {filteredCatalog !== null && filteredCatalog.length > 0 && (
          <div>
            <div className="text-[11px] font-semibold text-rh-text-dim mb-1.5">Додані спільнотою</div>
            <div className="flex flex-col gap-1.5">
              {filteredCatalog.map((item) => {
                const { isDownloaded, isDownloading, percent } = downloadState(item.filename)
                const { mine, avg, count } = ratingsFor(item.filename)
                return (
                  <div
                    key={item.id}
                    onClick={() => setDetail({ kind: 'catalog', item })}
                    className="flex items-center gap-3 rounded-lg border border-rh-border px-3 py-2.5 cursor-pointer hover:border-rh-accent/50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium truncate">{item.label}</div>
                      <div className="font-mono text-[10.5px] text-rh-muted truncate mt-0.5">{item.filename}</div>
                      <div className="text-[10px] text-rh-muted mt-0.5">Додав: {item.added_by}</div>
                      <div className="flex items-center gap-2 mt-1.5" onClick={(e) => e.stopPropagation()}>
                        <Stars value={mine || Math.round(avg)} filled={mine > 0} onRate={(v) => rate(item.filename, v)} />
                        {count > 0 && <span className="text-[10px] text-rh-muted">{avg.toFixed(1)} ({count})</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      {isDownloading ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-rh-text-dim px-3 py-1.5">
                          <Spinner size={12} /> {percent}%
                        </div>
                      ) : isDownloaded ? (
                        <>
                          <span className="text-[11px] font-semibold text-emerald-400 px-3 py-1.5">Завантажено</span>
                          <button
                            onClick={() => deleteDownloaded(item.filename)}
                            className="text-rh-muted hover:text-[#FF6B70]"
                            title="Видалити завантажений файл з цього ПК"
                          >
                            <TrashIcon />
                          </button>
                        </>
                      ) : (
                        <button onClick={() => downloadCatalogModel(item)} className="rh-btn-primary text-[11px] px-3 py-1.5">
                          Завантажити
                        </button>
                      )}
                      {(isAdmin || item.added_by === activeProfile?.name) && (
                        <button
                          onClick={() => removeCatalogModel(item.id)}
                          className="text-rh-muted hover:text-[#FF6B70] text-xs"
                          title="Видалити зі спільного каталогу"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div>
          {filteredCatalog && filteredCatalog.length > 0 && (
            <div className="text-[11px] font-semibold text-rh-text-dim mb-1.5">Реєстр audio-separator</div>
          )}
          {filteredEntries === null && (
            <div className="flex justify-center py-8"><Spinner size={18} className="text-rh-accent" /></div>
          )}
          {filteredEntries?.length === 0 && (!filteredCatalog || filteredCatalog.length === 0) && (
            <div className="text-xs text-rh-muted text-center py-6">
              {onlyDownloaded ? 'Ще нічого не завантажено для цього методу' : 'Нічого не знайдено'}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {filteredEntries?.map((entry) => {
              const { isDownloaded, isDownloading, percent } = downloadState(entry.filename)
              const { mine, avg, count } = ratingsFor(entry.filename)

              return (
                <div
                  key={entry.filename}
                  onClick={() => setDetail({ kind: 'registry', entry })}
                  className="flex items-center gap-3 rounded-lg border border-rh-border px-3 py-2.5 cursor-pointer hover:border-rh-accent/50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate flex items-center gap-1.5">
                      {entry.label}
                      {entry.is_vocal_separator === false && (
                        <span
                          className="text-[9px] font-bold uppercase tracking-wide text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded px-1 py-0.5 flex-shrink-0"
                          title={`Стеми: ${entry.stems.join(', ') || '—'}`}
                        >
                          не вокал/інструментал
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-[10.5px] text-rh-muted truncate mt-0.5">{entry.filename}</div>
                    <div className="flex items-center gap-2 mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <Stars value={mine || Math.round(avg)} filled={mine > 0} onRate={(v) => rate(entry.filename, v)} />
                      {count > 0 && <span className="text-[10px] text-rh-muted">{avg.toFixed(1)} ({count})</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    {isDownloading ? (
                      <div className="flex items-center gap-1.5 text-[11px] text-rh-text-dim px-3 py-1.5">
                        <Spinner size={12} /> {percent}%
                      </div>
                    ) : isDownloaded ? (
                      <>
                        <span className="text-[11px] font-semibold text-emerald-400 px-3 py-1.5">Завантажено</span>
                        <button
                          onClick={() => deleteDownloaded(entry.filename)}
                          className="text-rh-muted hover:text-[#FF6B70]"
                          title="Видалити завантажений файл з цього ПК"
                        >
                          <TrashIcon />
                        </button>
                      </>
                    ) : (
                      <button onClick={() => downloadRegistryModel(entry.filename)} className="rh-btn-primary text-[11px] px-3 py-1.5">
                        Завантажити
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {detail && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" {...detailBackdrop}>
          <div
            className="rh-card w-[520px] max-w-full max-h-[80vh] overflow-y-auto p-6 flex flex-col gap-4 shadow-2xl select-text"
            onClick={(e) => e.stopPropagation()}
          >
            {detail.kind === 'registry' ? (
              <RegistryDetail entry={detail.entry} ratings={ratingsFor(detail.entry.filename).all} onClose={() => setDetail(null)} />
            ) : (
              <CatalogDetail item={detail.item} ratings={ratingsFor(detail.item.filename).all} onClose={() => setDetail(null)} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] text-rh-muted uppercase tracking-wide">{label}</div>
      <div className="font-mono text-xs text-rh-text-dim break-words mt-0.5">{value}</div>
    </div>
  )
}

function RatingsBreakdown({ ratings }: { ratings: ModelRating[] }) {
  if (ratings.length === 0) {
    return <div className="text-[11px] text-rh-muted">Ще ніхто не оцінив</div>
  }
  return (
    <div className="flex flex-col gap-1">
      {ratings.map((r) => (
        <div key={r.profile_name} className="flex items-center justify-between text-[11px]">
          <span className="text-rh-text-dim">{r.profile_name}</span>
          <span className="text-amber-400">{'★'.repeat(r.rating)}<span className="text-rh-border">{'★'.repeat(5 - r.rating)}</span></span>
        </div>
      ))}
    </div>
  )
}

function RegistryDetail({ entry, ratings, onClose }: { entry: RegistryEntry; ratings: ModelRating[]; onClose: () => void }) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold">{entry.label}</h2>
        <button onClick={onClose} className="text-rh-muted hover:text-rh-text text-lg leading-none px-1 flex-shrink-0">✕</button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <DetailRow label="Файл" value={entry.filename} />
        <DetailRow label="Джерело" value="Реєстр audio-separator" />
        <DetailRow
          label="Розділяє вокал/інструментал"
          value={entry.is_vocal_separator === false ? 'Ні' : entry.is_vocal_separator === null ? 'Невідомо' : 'Так'}
        />
        <DetailRow label="Стеми" value={entry.stems.length ? entry.stems.join(', ') : '—'} />
      </div>
      <div>
        <div className="text-[11px] font-semibold text-rh-text-dim mb-1.5">Оцінки студії</div>
        <RatingsBreakdown ratings={ratings} />
      </div>
    </>
  )
}

function CatalogDetail({ item, ratings, onClose }: { item: CatalogModel; ratings: ModelRating[]; onClose: () => void }) {
  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold">{item.label}</h2>
        <button onClick={onClose} className="text-rh-muted hover:text-rh-text text-lg leading-none px-1 flex-shrink-0">✕</button>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <DetailRow label="Файл" value={item.filename} />
        <DetailRow label="Метод" value={item.method} />
        <DetailRow label="Архітектура" value={item.arch} />
        <DetailRow label="Додав" value={item.added_by} />
        <DetailRow label="Додано" value={new Date(item.created_at).toLocaleString()} />
        <DetailRow
          label="Джерело"
          value={<a href={item.source_url} target="_blank" rel="noreferrer" className="text-rh-accent hover:underline break-all">{item.source_url}</a>}
        />
      </div>
      {item.notes && (
        <div>
          <div className="text-[11px] font-semibold text-rh-text-dim mb-1">Примітки</div>
          <div className="text-xs text-rh-text-dim">{item.notes}</div>
        </div>
      )}
      <div>
        <div className="text-[11px] font-semibold text-rh-text-dim mb-1.5">Оцінки студії</div>
        <RatingsBreakdown ratings={ratings} />
      </div>
    </>
  )
}

function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
    </svg>
  )
}

function Stars({ value, filled, onRate }: { value: number; filled: boolean; onRate: (v: number) => void }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          onClick={() => onRate(n)}
          title={`Оцінити на ${n}`}
          className={`text-sm leading-none transition-colors ${
            n <= value ? (filled ? 'text-amber-400' : 'text-rh-text-dim') : 'text-rh-border hover:text-amber-400/50'
          }`}
        >
          ★
        </button>
      ))}
    </div>
  )
}
