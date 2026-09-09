import React, { useEffect, useState } from 'react'
import { Spinner } from './ui/Spinner'
import { Toggle } from './ui/Toggle'
import { useApi } from '../hooks/useApi'
import { useBackdropClose } from '../hooks/useBackdropClose'
import type { ApexModelItem, AppSettings, ModelsConfig, PersonalEnsembleModelItem } from '../types'

// "Апекс" and "МійАнсамбль" are both ensemble-only pseudo-methods — no
// checkpoint dropdown or per-architecture advanced settings of their own
// (see isApex/isPersonal below). Апекс's line-up is DB-backed and shared
// studio-wide (admin-curated, see backend's APEX_MODELS_DEFAULT); МійАнсамбль
// is the same idea but per-profile and local-only, starting empty — anyone
// picks their own models for it (added from the Model Browser), not just
// an admin (see backend's PersonalEnsembleModel).
export const SEPARATION_MODELS = ['MDX-Net', 'VR Arch', 'Demucs', 'MDX23C', 'BS-RoFormer', 'Апекс', 'МійАнсамбль', 'MVSep'] as const
export type SeparationModel = typeof SEPARATION_MODELS[number]

// Fetched from GET /teams/mvsep-eligible-models (backend mvsep_service.
// MVSEP_CATEGORIES) rather than hardcoded — that list has grown into
// several categories with a premium flag per model, no longer the kind of
// short static thing worth hand-mirroring (see MVSEP_MAX_BATCH below for
// the one MVSep constant that IS still hardcoded here, since it's a
// frontend-only UX cap, not a fact about MVSep itself).
type MvsepModel = { label: string; sepType: string; addOpt1: string; premium: boolean }
type MvsepCategory = { category: string; models: MvsepModel[] }

// MVSep costs real studio credits per model run (unlike the free local
// batch, which always runs every model) — capped here to match the
// server-side cap in routers/episodes.py's batch-separate-vocals, so a
// rejected 6th pick fails in the UI immediately rather than round-tripping
// to the backend first.
const MVSEP_MAX_BATCH = 5

type Arch = 'mdx' | 'vr' | 'demucs' | 'mdxc'

// MDX23C and BS-RoFormer are both "mdxc" architecture models in
// audio-separator — same advanced-settings shape, matching backend's
// MODEL_ARCH in services/separator_service.py. "Апекс"/"МійАнсамбль" never
// actually read this (their advanced-settings/model-select UI is hidden
// entirely, see isApex/isPersonal below) — the entries only exist to
// satisfy the Record's type.
const MODEL_ARCH: Record<SeparationModel, Arch> = {
  'MDX-Net': 'mdx',
  'VR Arch': 'vr',
  Demucs: 'demucs',
  MDX23C: 'mdxc',
  'BS-RoFormer': 'mdxc',
  Апекс: 'mdxc',
  МійАнсамбль: 'mdxc',
  MVSep: 'mdxc',
}

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

// Every key here mirrors audio-separator's own Separator(...) defaults
// exactly — its architecture classes read these via `arch_config.get("key")`
// with no fallback of their own, so a partial dict would silently turn any
// missing key into None. Keep every key present even where there's no UI
// control for it (hop_length, batch_size, etc.) — carried through unchanged.
interface MdxParams { hop_length: number; segment_size: number; overlap: number; batch_size: number; enable_denoise: boolean }
interface VrParams { batch_size: number; window_size: number; aggression: number; enable_tta: boolean; enable_post_process: boolean; post_process_threshold: number; high_end_process: boolean }
interface DemucsParams { segment_size: string; shifts: number; overlap: number; segments_enabled: boolean }
interface MdxcParams { segment_size: number; override_model_segment_size: boolean; batch_size: number; overlap: number; pitch_shift: number }

const DEFAULT_MDX: MdxParams = { hop_length: 1024, segment_size: 256, overlap: 0.25, batch_size: 1, enable_denoise: false }
const DEFAULT_VR: VrParams = { batch_size: 1, window_size: 512, aggression: 5, enable_tta: false, enable_post_process: false, post_process_threshold: 0.2, high_end_process: false }
const DEFAULT_DEMUCS: DemucsParams = { segment_size: 'Default', shifts: 2, overlap: 0.25, segments_enabled: true }
const DEFAULT_MDXC: MdxcParams = { segment_size: 256, override_model_segment_size: false, batch_size: 1, overlap: 8, pitch_shift: 0 }

export interface SeparationParams {
  mdx?: MdxParams
  vr?: VrParams
  demucs?: DemucsParams
  mdxc?: MdxcParams
}

interface VocalSeparationModalProps {
  onClose: () => void
  onRun: (model: SeparationModel, ensemble: boolean, modelFile?: string, params?: SeparationParams) => void
  onRequestPower: (model: SeparationModel, ensemble: boolean, modelFile?: string, params?: SeparationParams) => void
  // mvsepModels is only passed for MVSep's own batch mode (see
  // toggleMvsepBatchModel below) — omitted entirely for the local batch,
  // which still always runs every free model with no picking.
  onRunBatch: (mvsepModels?: Array<{ label: string; sepType: string; addOpt1: string }>) => void
  onRunDistributed: (model: SeparationModel, ensemble: boolean, modelFile?: string, params?: SeparationParams) => void
  separating: boolean
  requestingPower: boolean
  batchRendering: boolean
  distributedRunning: boolean
  powerShareEnabled: boolean
  powerShareError: string | null
  separationError: string | null
  disabled: boolean
  // MVSep's "take the already-isolated vocal and split IT into male/female"
  // (backend: run_mvsep_male_female_split) — deliberately excluded from
  // MVSEP_CATEGORIES/the main model list above (see mvsep_service.py's own
  // comment: it produces male_vocals/female_vocals only, no instrumental,
  // so it can never satisfy the normal "run separation" vocal+instrumental
  // contract). Still belongs under the MVSep method tab rather than as an
  // unrelated top-toolbar button, since it's still an MVSep action.
  vocalIsolated: boolean
  maleFemaleEligible: boolean
  maleFemaleSplitBusy: boolean
  onMaleFemaleSplit: () => void
}

export function VocalSeparationModal({
  onClose, onRun, onRequestPower, onRunBatch, onRunDistributed, separating, requestingPower,
  batchRendering, distributedRunning, powerShareEnabled, powerShareError, separationError, disabled,
  vocalIsolated, maleFemaleEligible, maleFemaleSplitBusy, onMaleFemaleSplit,
}: VocalSeparationModalProps) {
  const backdrop = useBackdropClose(onClose)
  const { get, post, del } = useApi()
  const [model, setModel] = useState<SeparationModel>('MDX-Net')
  const [ensemble, setEnsemble] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  // Mutually exclusive with each other (not with ensemble/batch) — asking one
  // peer for its whole power vs. splitting across every available peer are
  // two different modes of the same underlying action, never both at once.
  const [requestPowerMode, setRequestPowerMode] = useState(false)
  const [distributedMode, setDistributedMode] = useState(false)
  const [modelFile, setModelFile] = useState('')
  const [mdx, setMdx] = useState(DEFAULT_MDX)
  const [vr, setVr] = useState(DEFAULT_VR)
  const [demucs, setDemucs] = useState(DEFAULT_DEMUCS)
  const [mdxc, setMdxc] = useState(DEFAULT_MDXC)

  // Fetched from the backend rather than hardcoded here — a hardcoded copy
  // of this list previously drifted out of sync with a backend model-list
  // fix and kept offering a model already confirmed broken (VR Arch's old
  // de-echo default). This is also how a Model Browser-downloaded custom
  // model (see ModelBrowserPage.tsx — adding models here directly was
  // removed in favor of that shared, server-backed catalog) shows up.
  const [modelsConfig, setModelsConfig] = useState<ModelsConfig | null>(null)

  // GPU/CPU is a single global setting (see Налаштування), not per-model or
  // per-method — the same install/enable flips acceleration on for both the
  // ONNX-based MDX-Net path and the torch-based VR Arch/Demucs/MDX23C/
  // BS-RoFormer path at once (see separator_service.py's
  // _patch_separator_gpu_detection and gpu_runtime_service.py), so a single
  // computed status covers every method/model choice below.
  const [gpuSettings, setGpuSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    get<ModelsConfig>('/models').then(setModelsConfig).catch(() => {})
    get<AppSettings>('/settings').then(setGpuSettings).catch(() => {})
  }, [get])

  const usingGpu = !!(gpuSettings?.gpu_available && gpuSettings?.gpu_enabled && gpuSettings?.gpu_runtime_installed)
  const gpuStatusLabel = !gpuSettings
    ? null
    : usingGpu
    ? 'GPU (CUDA)'
    : !gpuSettings.gpu_available
    ? 'CPU — GPU NVIDIA не знайдено'
    : !gpuSettings.gpu_enabled
    ? 'CPU — GPU вимкнено в Налаштуваннях'
    : 'CPU — бібліотеки GPU ще не встановлені'

  const modelChoices = modelsConfig?.choices[model] ?? []

  // Keep the selected checkpoint valid whenever the method or the model
  // list itself changes (e.g. right after the initial fetch resolves, or
  // after adding/removing a custom model).
  useEffect(() => {
    if (modelChoices.length && !modelChoices.some((c) => c.file === modelFile)) {
      setModelFile(modelChoices[0].file)
    }
  }, [model, modelChoices, modelFile])

  const arch = MODEL_ARCH[model]
  const isApex = model === 'Апекс'
  // Gates editing Апекс's line-up (see ProfileModal's "type admin as your
  // role" unlock flow) — everyone can still select and run Апекс, only
  // changing its composition is admin-only.
  const isAdminUser = !!gpuSettings?.active_profile?.is_admin

  // Апекс's own line-up — fetched lazily (only once Апекс is actually
  // selected, not on every modal open) and editable right here, so changing
  // which models it averages takes effect on the very next run — no rebuild.
  const [apexModels, setApexModels] = useState<ApexModelItem[] | null>(null)
  const [addingApexModel, setAddingApexModel] = useState(false)
  const [apexMethod, setApexMethod] = useState<SeparationModel>('BS-RoFormer')
  const [apexLabel, setApexLabel] = useState('')
  const [apexFilename, setApexFilename] = useState('')
  const [apexError, setApexError] = useState<string | null>(null)
  const [apexBusy, setApexBusy] = useState(false)

  useEffect(() => {
    if (!isApex || apexModels !== null) return
    get<ApexModelItem[]>('/models/apex').then(setApexModels).catch(() => {})
  }, [isApex, apexModels, get])

  async function refreshApexModels() {
    const refreshed = await get<ApexModelItem[]>('/models/apex')
    setApexModels(refreshed)
    return refreshed
  }

  async function submitApexModel() {
    const label = apexLabel.trim()
    const filename = apexFilename.trim()
    if (!label || !filename) {
      setApexError('Вкажіть назву і точну назву файлу моделі')
      return
    }
    setApexBusy(true)
    setApexError(null)
    try {
      await post('/models/apex', { method: apexMethod, label, filename })
      await refreshApexModels()
      setApexLabel('')
      setApexFilename('')
      setAddingApexModel(false)
    } catch (e) {
      setApexError(extractApiError(e, 'Не вдалося додати модель'))
    } finally {
      setApexBusy(false)
    }
  }

  async function removeApexModel(id: number) {
    try {
      await del(`/models/apex/${id}`)
      await refreshApexModels()
    } catch (e) {
      setApexError(extractApiError(e, 'Не вдалося видалити модель'))
    }
  }

  // "Мій ансамбль" — same DB-backed live-editable idea as Апекс above, but
  // per-profile and local (see backend's PersonalEnsembleModel) and starts
  // empty for everyone: models are added from the Model Browser (click a
  // model → "+ до мого ансамблю"), not typed in here — this modal only
  // shows the current pick and lets you remove one.
  const isPersonal = model === 'МійАнсамбль'
  const [personalModels, setPersonalModels] = useState<PersonalEnsembleModelItem[] | null>(null)
  const [personalError, setPersonalError] = useState<string | null>(null)

  useEffect(() => {
    if (!isPersonal || personalModels !== null) return
    get<PersonalEnsembleModelItem[]>('/models/personal-ensemble').then(setPersonalModels).catch(() => {})
  }, [isPersonal, personalModels, get])

  // Cloud separation via mvsep.com — the only method here that isn't a
  // local audio-separator model at all (see backend mvsep_service.py).
  // No longer beta-gated (confirmed live 2026-08-18 — it was invisible in
  // the method picker with no way to reach it at all until this) — still
  // server-checked against credits eligibility (team credits_enabled or an
  // individual grant, both app-admin controlled — see team_service.py);
  // eligibility is re-checked server-side on run too, this is just for
  // hiding the option from someone it wouldn't work for anyway.
  const isMvsep = model === 'MVSep'
  const [mvsepCategories, setMvsepCategories] = useState<MvsepCategory[] | null>(null)
  const [mvsepChoice, setMvsepChoice] = useState<MvsepModel | null>(null)
  const [mvsepEligible, setMvsepEligible] = useState(false)
  // MVSep's own batch mode — separate from the local batchMode toggle
  // (hidden entirely while isMvsep, see the "!isMvsep &&" wrapper below)
  // because MVSep costs real credits per model, so it's an explicit
  // multi-select capped at MVSEP_MAX_BATCH rather than "run everything."
  const [mvsepBatch, setMvsepBatch] = useState(false)
  const [mvsepBatchSelected, setMvsepBatchSelected] = useState<MvsepModel[]>([])
  const [mvsepBalance, setMvsepBalance] = useState<{ premium_minutes: number | null; premium_enabled: boolean } | null>(null)
  const [mvsepBalanceError, setMvsepBalanceError] = useState<string | null>(null)

  useEffect(() => {
    get<{ eligible: boolean }>('/teams/mvsep-eligible').then((r) => setMvsepEligible(r.eligible)).catch(() => {})
  }, [get])

  useEffect(() => {
    if (!isMvsep || mvsepCategories !== null) return
    get<MvsepCategory[]>('/teams/mvsep-models').then((cats) => {
      setMvsepCategories(cats)
      setMvsepChoice(cats[0]?.models[0] ?? null)
    }).catch(() => {})
  }, [isMvsep, mvsepCategories, get])

  useEffect(() => {
    if (!isMvsep || !mvsepEligible || mvsepBalance || mvsepBalanceError) return
    get<{ premium_minutes: number | null; premium_enabled: boolean }>('/teams/mvsep-balance')
      .then(setMvsepBalance)
      .catch((e) => setMvsepBalanceError(extractApiError(e, 'Не вдалося отримати баланс MVSep')))
  }, [isMvsep, mvsepEligible, mvsepBalance, mvsepBalanceError, get])

  function toggleMvsepBatchModel(m: MvsepModel) {
    setMvsepBatchSelected((prev) => {
      const exists = prev.some((p) => p.sepType === m.sepType && p.addOpt1 === m.addOpt1)
      if (exists) return prev.filter((p) => !(p.sepType === m.sepType && p.addOpt1 === m.addOpt1))
      if (prev.length >= MVSEP_MAX_BATCH) return prev
      return [...prev, m]
    })
  }

  async function removePersonalModel(id: number) {
    try {
      await del(`/models/personal-ensemble/${id}`)
      const refreshed = await get<PersonalEnsembleModelItem[]>('/models/personal-ensemble')
      setPersonalModels(refreshed)
    } catch (e) {
      setPersonalError(extractApiError(e, 'Не вдалося видалити модель'))
    }
  }

  function toggleRequestPower(checked: boolean) {
    setRequestPowerMode(checked)
    if (checked) setDistributedMode(false)
  }

  function toggleDistributed(checked: boolean) {
    setDistributedMode(checked)
    if (checked) setRequestPowerMode(false)
  }

  function selectMethod(m: SeparationModel) {
    setModel(m)
    const choices = modelsConfig?.choices[m]
    if (choices && choices.length) setModelFile(choices[0].file)
    // MVSep is a single cloud call — batch/power-share/distributed modes
    // don't apply and their toggles are hidden while it's selected, but
    // stale state from a prior method would otherwise still be read by
    // handleRunClick and silently hijack the run.
    if (m === 'MVSep') {
      setBatchMode(false)
      setRequestPowerMode(false)
      setDistributedMode(false)
    }
  }

  // "Свої моделі" — a shortcut picker over every custom/Model Browser model
  // already downloaded on this install, spanning every method at once, so
  // picking one doesn't require first remembering which method category it
  // belongs to. Not a real method itself: choosing one just resolves to the
  // model's actual method + file via the normal selectMethod/setModelFile
  // path below and drops back into the regular per-method view, so every
  // other piece of run logic (buildParams, handleRunClick) needs no changes.
  const [showOwnModels, setShowOwnModels] = useState(false)
  const ownModels = SEPARATION_MODELS.filter((m) => m !== 'Апекс' && m !== 'МійАнсамбль').flatMap((m) =>
    (modelsConfig?.choices[m] ?? []).filter((c) => c.custom).map((c) => ({ method: m, ...c }))
  )

  function buildParams(): SeparationParams | undefined {
    // Ensemble runs all 5 default models spanning every architecture —
    // a single settings panel can't map cleanly onto that, so it always
    // uses the library's own defaults. Апекс, unlike Ensemble, is
    // predominantly mdxc-architecture (BS-Roformer/MDX23C/MelBand — only
    // Kim Vocal 2 in the line-up is mdx) and its cleanup pass is mdxc too
    // (see backend's _apex_cleanup_pass), so the mdxc segment/overlap
    // controls below apply meaningfully to it and are sent through. Мій
    // ансамбль can mix any architecture (it's whatever the person picked),
    // so — like the generic Ensemble Mode — it just uses each model's own
    // library defaults rather than one settings panel pretending to fit all.
    if (ensemble || isPersonal || isMvsep) return undefined
    if (isApex) return { mdxc }
    if (arch === 'mdx') return { mdx }
    if (arch === 'vr') return { vr }
    if (arch === 'demucs') return { demucs }
    return { mdxc }
  }

  const busy = separating || requestingPower || batchRendering || distributedRunning

  // A single "Запустити" button whose behavior follows whichever toggle is
  // switched on — like flipping a switch rather than picking from several
  // separate buttons that each did something different.
  function handleRunClick() {
    if (isMvsep && mvsepBatch) {
      onRunBatch(mvsepBatchSelected.map((m) => ({ label: m.label, sepType: m.sepType, addOpt1: m.addOpt1 })))
      return
    }
    const file = isMvsep
      ? mvsepChoice ? `${mvsepChoice.sepType}:${mvsepChoice.addOpt1}` : undefined
      : ensemble || isApex || isPersonal ? undefined : modelFile
    if (batchMode) { onRunBatch(); return }
    if (distributedMode) { onRunDistributed(model, ensemble, file, buildParams()); return }
    if (requestPowerMode) { onRequestPower(model, ensemble, file, buildParams()); return }
    onRun(model, ensemble, file, buildParams())
  }

  const runLabel = isMvsep && mvsepBatch
    ? 'Запустити пакетний рендер MVSep'
    : batchMode
    ? 'Запустити пакетний рендер'
    : distributedMode
    ? 'Запустити розподілену обробку'
    : requestPowerMode
    ? 'Запросити потужність'
    : 'Запустити'

  const mvsepRunDisabled = isMvsep && (mvsepBatch ? mvsepBatchSelected.length === 0 : !mvsepChoice)

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" {...backdrop}>
      <div className="rh-card w-[620px] max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Ізоляція вокалу</h2>
          <button onClick={onClose} className="text-rh-muted hover:text-white text-lg leading-none px-1">✕</button>
        </div>

        {gpuStatusLabel && (
          <div className="flex items-center gap-1.5 -mt-3 text-[11px] text-rh-text-dim">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${usingGpu ? 'bg-emerald-400' : 'bg-rh-muted'}`} />
            Обробка: {gpuStatusLabel}
          </div>
        )}

        {/* Method picker */}
        <div className="flex flex-col gap-2">
          <span className="text-xs text-rh-muted">Метод</span>
          <div className="grid grid-cols-3 gap-1.5">
            {SEPARATION_MODELS.map((m) => {
              const isApexButton = m === 'Апекс'
              const isPersonalButton = m === 'МійАнсамбль'
              const isMvsepButton = m === 'MVSep'
              const active = model === m && !ensemble && !showOwnModels
              return (
                <button
                  key={m}
                  onClick={() => { setShowOwnModels(false); selectMethod(m) }}
                  disabled={ensemble}
                  title={
                    isApexButton ? 'Кураторський ансамбль найсильніших моделей — для максимально чистого результату'
                    : isPersonalButton ? 'Ваш власний ансамбль — оберіть моделі у Браузері моделей'
                    : isMvsepButton ? 'Хмарне розділення mvsep.com — потребує кредитів (бета)'
                    : undefined
                  }
                  className={`px-2 py-2 rounded-lg text-xs font-medium transition-colors border
                    ${active
                      ? isApexButton
                        ? 'bg-gradient-to-br from-amber-400 to-amber-600 text-black border-amber-400'
                        : isPersonalButton
                        ? 'bg-gradient-to-br from-violet-500 to-violet-700 text-white border-violet-500'
                        : isMvsepButton
                        ? 'bg-gradient-to-br from-cyan-500 to-cyan-700 text-white border-cyan-500'
                        : 'bg-rh-accent text-white border-rh-accent'
                      : isApexButton
                        ? 'text-amber-400 border-amber-500/40 hover:text-amber-300 hover:border-amber-400/60'
                        : isPersonalButton
                        ? 'text-violet-400 border-violet-500/40 hover:text-violet-300 hover:border-violet-400/60'
                        : isMvsepButton
                        ? 'text-cyan-400 border-cyan-500/40 hover:text-cyan-300 hover:border-cyan-400/60'
                        : 'text-rh-muted border-rh-border hover:text-rh-text hover:border-rh-border2'}
                    ${ensemble ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  {isApexButton ? '★ Апекс' : isPersonalButton ? '☆ Мій ансамбль' : isMvsepButton ? '☁ MVSep' : m}
                </button>
              )
            })}
            <button
              onClick={() => setShowOwnModels((v) => !v)}
              disabled={ensemble}
              className={`px-2 py-2 rounded-lg text-xs font-medium transition-colors border
                ${showOwnModels
                  ? 'bg-rh-accent text-white border-rh-accent'
                  : 'text-rh-muted border-rh-border hover:text-rh-text hover:border-rh-border2'}
                ${ensemble ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              Свої моделі
            </button>
          </div>

          {showOwnModels && !ensemble && (
            <div className="flex flex-col gap-1 border border-rh-border rounded-lg px-2.5 py-2 max-h-[160px] overflow-y-auto">
              {ownModels.length === 0 && (
                <p className="text-[11px] text-rh-muted">
                  Ще нічого не завантажено. Завантажте моделі в Браузері моделей (бічна панель).
                </p>
              )}
              {ownModels.map((c) => (
                <button
                  key={`${c.method}:${c.file}`}
                  onClick={() => { selectMethod(c.method); setModelFile(c.file); setShowOwnModels(false) }}
                  className="flex items-center gap-2 text-left text-[11px] rounded px-2 py-1.5 hover:bg-white/5 transition-colors"
                >
                  <span className="flex-1 truncate">{c.label}</span>
                  <span className="text-[10px] text-rh-muted flex-shrink-0">{c.method}</span>
                </button>
              ))}
            </div>
          )}

          {isApex && !ensemble && (
            <div className="flex flex-col gap-1.5 border border-amber-500/30 rounded-lg px-2.5 py-2 bg-amber-400/5">
              <p className="text-[10.5px] text-amber-400/90 italic leading-snug">
                На думку єнота, цей набір непогано звучить — але єнот завжди може передумати.
              </p>

              {apexModels === null && (
                <div className="flex justify-center py-2"><Spinner size={12} className="text-amber-400" /></div>
              )}

              {apexModels && (
                <div className="flex flex-col gap-1">
                  {apexModels.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 text-[11px] text-amber-100/80">
                      <span className="truncate flex-1">{m.label}</span>
                      <span className="text-[10px] text-amber-400/60 flex-shrink-0">{m.method}</span>
                      <span className="font-mono text-amber-100/50 truncate max-w-[140px]">{m.filename}</span>
                      {isAdminUser && (
                        <button
                          onClick={() => removeApexModel(m.id)}
                          className="text-amber-100/50 hover:text-[#FF6B70] flex-shrink-0"
                          title="Прибрати з Апекс"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {isAdminUser && (
              <button
                onClick={() => { setAddingApexModel((v) => !v); setApexError(null) }}
                className="text-[11px] font-semibold text-amber-400 hover:text-amber-300 self-start"
              >
                {addingApexModel ? 'Скасувати' : '+ Додати модель до Апекс'}
              </button>
              )}

              {isAdminUser && addingApexModel && (
                <div className="flex flex-col gap-1.5 mt-1">
                  <select
                    className="rh-input text-[12px]"
                    value={apexMethod}
                    onChange={(e) => setApexMethod(e.target.value as SeparationModel)}
                  >
                    {SEPARATION_MODELS.filter((m) => m !== 'Апекс' && m !== 'МійАнсамбль').map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <input
                    value={apexLabel}
                    onChange={(e) => setApexLabel(e.target.value)}
                    placeholder="Назва для показу, напр. Kim Vocal 1"
                    className="rh-input text-[12px]"
                  />
                  <input
                    value={apexFilename}
                    onChange={(e) => setApexFilename(e.target.value)}
                    placeholder="Точний файл з реєстру, напр. Kim_Vocal_1.onnx"
                    className="rh-input text-[12px] font-mono"
                  />
                  {apexError && <span className="text-[11px] text-[#FF6B70]">{apexError}</span>}
                  <button
                    onClick={submitApexModel}
                    disabled={apexBusy}
                    className="rh-btn-primary text-[11px] self-start px-3 py-1.5"
                  >
                    {apexBusy ? <Spinner size={11} /> : null}
                    Додати
                  </button>
                </div>
              )}
            </div>
          )}

          {isPersonal && !ensemble && (
            <div className="flex flex-col gap-1.5 border border-violet-500/30 rounded-lg px-2.5 py-2 bg-violet-500/5">
              {personalModels === null && (
                <div className="flex justify-center py-2"><Spinner size={12} className="text-violet-400" /></div>
              )}

              {personalModels && personalModels.length === 0 && (
                <p className="text-[11px] text-violet-200/70 leading-snug">
                  Ще порожньо — відкрийте Браузер моделей і додайте моделі до свого ансамблю
                  (кнопка «+ до мого ансамблю» на картці моделі).
                </p>
              )}

              {personalModels && personalModels.length > 0 && (
                <div className="flex flex-col gap-1">
                  {personalModels.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 text-[11px] text-violet-100/80">
                      <span className="truncate flex-1">{m.label}</span>
                      <span className="text-[10px] text-violet-400/60 flex-shrink-0">{m.method}</span>
                      <span className="font-mono text-violet-100/50 truncate max-w-[140px]">{m.filename}</span>
                      <button
                        onClick={() => removePersonalModel(m.id)}
                        className="text-violet-100/50 hover:text-[#FF6B70] flex-shrink-0"
                        title="Прибрати зі свого ансамблю"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {personalError && <span className="text-[11px] text-[#FF6B70]">{personalError}</span>}
            </div>
          )}

          {isMvsep && !ensemble && (
            <div className="flex flex-col gap-1.5 border border-cyan-500/30 rounded-lg px-2.5 py-2 bg-cyan-500/5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10.5px] text-cyan-300/90 italic leading-snug">
                  Хмарне розділення на mvsep.com — файл іде на сторонній сервер, обробка займає час і витрачає кредити студії.
                </p>
                <span className="text-[10px] font-semibold text-cyan-300 bg-cyan-500/15 border border-cyan-500/30 rounded px-1.5 py-0.5 flex-shrink-0">
                  💳 Кредити
                </span>
              </div>

              {mvsepEligible && (
                <p className="text-[10.5px] text-cyan-200/80">
                  {mvsepBalance
                    ? `Баланс студії: ${mvsepBalance.premium_minutes ?? 0} хв преміум${mvsepBalance.premium_enabled ? '' : ' (преміум вимкнено — деякі моделі нижче можуть бути недоступні)'}`
                    : mvsepBalanceError
                    ? mvsepBalanceError
                    : 'Завантажую баланс…'}
                </p>
              )}

              {!mvsepEligible && (
                <p className="text-[11px] text-[#FF6B70] leading-snug">
                  Кредити недоступні для цього профілю — зверніться до адміна програми або адміна команди.
                </p>
              )}

              <Toggle
                size="sm"
                checked={mvsepBatch}
                onChange={setMvsepBatch}
                label={`Пакетний рендер MVSep — обрати кілька моделей (до ${MVSEP_MAX_BATCH}), кожна окремим файлом і окремими кредитами`}
              />

              {mvsepCategories === null && (
                <div className="flex justify-center py-2"><Spinner size={12} className="text-cyan-400" /></div>
              )}

              {mvsepCategories !== null && !mvsepBatch && (
                <Field label="Модель MVSep" hint="Конкретний алгоритм на боці mvsep.com.">
                  <select
                    className="rh-input"
                    value={mvsepChoice ? `${mvsepChoice.sepType}:${mvsepChoice.addOpt1}` : ''}
                    onChange={(e) => {
                      const [sepType, addOpt1] = e.target.value.split(':')
                      const found = mvsepCategories.flatMap((c) => c.models).find((m) => m.sepType === sepType && m.addOpt1 === addOpt1)
                      if (found) setMvsepChoice(found)
                    }}
                  >
                    {mvsepCategories.map((cat) => (
                      <optgroup key={cat.category} label={cat.category}>
                        {cat.models.map((m) => (
                          <option key={`${m.sepType}:${m.addOpt1}`} value={`${m.sepType}:${m.addOpt1}`}>
                            {m.label}{m.premium ? ' 🔒 преміум' : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {mvsepChoice?.premium && (
                    <div className="text-[10.5px] text-amber-400/80 mt-1">
                      🔒 Ця модель на mvsep.com позначена як преміум — може не спрацювати, якщо на токені студії немає преміум-хвилин.
                    </div>
                  )}
                </Field>
              )}

              {mvsepCategories !== null && mvsepBatch && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-[10.5px] text-cyan-200/70">
                    Обрано {mvsepBatchSelected.length}/{MVSEP_MAX_BATCH}
                  </div>
                  <div className="flex flex-col gap-2 max-h-[220px] overflow-y-auto pr-1">
                    {mvsepCategories.map((cat) => (
                      <div key={cat.category} className="flex flex-col gap-0.5">
                        <span className="text-[10px] uppercase tracking-wide text-cyan-400/60">{cat.category}</span>
                        {cat.models.map((m) => {
                          const checked = mvsepBatchSelected.some((p) => p.sepType === m.sepType && p.addOpt1 === m.addOpt1)
                          const atLimit = !checked && mvsepBatchSelected.length >= MVSEP_MAX_BATCH
                          return (
                            <label
                              key={`${m.sepType}:${m.addOpt1}`}
                              className={`flex items-center gap-2 text-[11px] px-1 py-0.5 rounded ${atLimit ? 'opacity-40' : 'hover:bg-white/5 cursor-pointer'}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={atLimit}
                                onChange={() => toggleMvsepBatchModel(m)}
                              />
                              <span className="flex-1 truncate text-cyan-100/90">{m.label}</span>
                              {m.premium && <span className="text-[10px] text-amber-400/80 flex-shrink-0">🔒</span>}
                            </label>
                          )
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {!ensemble && !isApex && !isPersonal && !isMvsep && !showOwnModels && (
            <Field label="Модель" hint="Конкретний чекпоінт цього методу — впливає на якість і швидкість.">
              <select className="rh-input" value={modelFile} onChange={(e) => setModelFile(e.target.value)}>
                {modelChoices.map((c) => (
                  <option key={c.file} value={c.file}>{c.label}{c.custom ? ' (з Браузера моделей)' : ''}</option>
                ))}
              </select>
              <div className="text-[10.5px] text-rh-muted mt-1">
                Шукаєте іншу модель? Завантажте й додайте її в Браузері моделей (бічна панель).
              </div>
            </Field>
          )}
          {/* MVSep is a single cloud call, not a local model — none of
              Ensemble/Batch/Power-share/Distributed apply to it. */}
          {!isMvsep && (
            <>
              <Toggle
                checked={ensemble}
                // Ensemble Mode's "one default per broad method" and Апекс's own
                // fixed 5-model set are two different, mutually exclusive
                // ensembles — switching one on while Апекс is selected would
                // otherwise silently run the generic ensemble instead, ignoring
                // the Апекс pick with no visible explanation.
                onChange={(v) => { setEnsemble(v); if (v && (isApex || isPersonal)) setModel(SEPARATION_MODELS[0]) }}
                className="mt-1"
                label="Ensemble Mode — запустити всі 5 методів і усереднити результат (повільніше, типові моделі й налаштування для кожного)"
              />
              <Toggle
                checked={batchMode}
                onChange={setBatchMode}
                label="Пакетний рендер — запустити всі 5 методів, кожен результат окремим файлом (без усереднення)"
              />
            </>
          )}
          {/* Ч/Ж split — takes the vocal already isolated for this episode
              (by any method) and further splits IT into male/female via
              MVSep, spending credits. Hidden entirely unless eligible, same
              "hide AND block" posture as everything else MVSep. */}
          {isMvsep && maleFemaleEligible && (
            <div className="border border-rh-border rounded-lg p-2.5 flex items-center gap-2.5">
              <div className="flex-1 text-[10.5px] text-rh-muted">
                Розділити вже виділений вокал цієї серії на чоловічий/жіночий (MVSep, витрачає кредити)
              </div>
              <button
                type="button"
                onClick={onMaleFemaleSplit}
                disabled={!vocalIsolated || maleFemaleSplitBusy}
                className="rh-btn-outline text-xs flex items-center gap-1.5 flex-shrink-0"
                title={vocalIsolated ? undefined : 'Спершу виділіть вокал для цієї серії'}
              >
                {maleFemaleSplitBusy ? <Spinner size={12} /> : null}
                Ч/Ж
              </button>
            </div>
          )}
          {/* Мій ансамбль is per-profile and purely local (see backend's
              PersonalEnsembleModel) — a peer machine has no access to it, so
              power-share/distributed modes are hidden while it's selected
              rather than failing confusingly mid-job. */}
          {powerShareEnabled && !isPersonal && !isMvsep && (
            <>
              <Toggle
                checked={requestPowerMode}
                onChange={toggleRequestPower}
                label="Запросити потужність — віддати всю задачу одному доступному ПК"
              />
              <Toggle
                checked={distributedMode}
                onChange={toggleDistributed}
                label="Розподілена обробка — розділити цей епізод між усіма доступними ПК одночасно"
              />
            </>
          )}
        </div>

        {/* Advanced settings — per architecture, UVR5-style. Апекс falls
            into the mdxc branch below (MODEL_ARCH['Апекс'] = 'mdxc') since
            its line-up and cleanup pass are predominantly mdxc — see
            buildParams' comment. */}
        {!ensemble && !isPersonal && !isMvsep && (
          <div className="border-t border-rh-border pt-4 flex flex-col gap-3">
            <span className="text-xs text-rh-muted">Розширені налаштування ({model})</span>
            {isApex && (
              <p className="text-[10.5px] text-amber-400/70 -mt-1 leading-snug">
                Застосовується до mdxc-моделей у складі Апекс (BS-Roformer/MDX23C/MelBand) і до другого чистового проходу.
              </p>
            )}

            {arch === 'mdx' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Розмір сегмента" hint="Менший — швидше і менше пам'яті. Більший — може дати кращий результат.">
                  <select className="rh-input" value={mdx.segment_size} onChange={(e) => setMdx({ ...mdx, segment_size: Number(e.target.value) })}>
                    {[128, 256, 512, 1024, 2048].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </Field>
                <Field label={`Перекриття (${mdx.overlap.toFixed(2)})`} hint="Більше значення — краща якість, довше обробка.">
                  <input type="range" min={0.05} max={0.95} step={0.05} value={mdx.overlap}
                    onChange={(e) => setMdx({ ...mdx, overlap: Number(e.target.value) })} className="w-full accent-rh-accent" />
                </Field>
                <Toggle
                  size="sm"
                  className="col-span-2"
                  checked={mdx.enable_denoise}
                  onChange={(v) => setMdx({ ...mdx, enable_denoise: v })}
                  label="Придушення шуму (Denoise) — трохи повільніше, чистіший результат"
                />
              </div>
            )}

            {arch === 'vr' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Розмір вікна" hint="Менший — точніше на різких переходах, повільніше.">
                  <select className="rh-input" value={vr.window_size} onChange={(e) => setVr({ ...vr, window_size: Number(e.target.value) })}>
                    {[320, 512, 1024].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </Field>
                <Field label={`Агресивність (${vr.aggression})`} hint="Наскільки сильно видаляти вокал з інструменталу.">
                  <input type="range" min={0} max={100} step={1} value={vr.aggression}
                    onChange={(e) => setVr({ ...vr, aggression: Number(e.target.value) })} className="w-full accent-rh-accent" />
                </Field>
                <Toggle
                  size="sm"
                  checked={vr.enable_tta}
                  onChange={(v) => setVr({ ...vr, enable_tta: v })}
                  label="TTA — точніше, вдвічі повільніше"
                />
                <Toggle
                  size="sm"
                  checked={vr.high_end_process}
                  onChange={(v) => setVr({ ...vr, high_end_process: v })}
                  label="Обробка високих частот"
                />
              </div>
            )}

            {arch === 'demucs' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label={`Зсуви / Shifts (${demucs.shifts})`} hint="Більше — краща якість, лінійно довше обробка.">
                  <input type="range" min={0} max={10} step={1} value={demucs.shifts}
                    onChange={(e) => setDemucs({ ...demucs, shifts: Number(e.target.value) })} className="w-full accent-rh-accent" />
                </Field>
                <Field label={`Перекриття (${demucs.overlap.toFixed(2)})`} hint="Більше значення — краща якість, довше обробка.">
                  <input type="range" min={0.05} max={0.95} step={0.05} value={demucs.overlap}
                    onChange={(e) => setDemucs({ ...demucs, overlap: Number(e.target.value) })} className="w-full accent-rh-accent" />
                </Field>
              </div>
            )}

            {arch === 'mdxc' && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Розмір сегмента" hint="Менший — швидше і менше пам'яті. Більший — може дати кращий результат.">
                  <select className="rh-input" value={mdxc.segment_size} onChange={(e) => setMdxc({ ...mdxc, segment_size: Number(e.target.value) })}>
                    {[128, 256, 512].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </Field>
                <Field label={`Перекриття (${mdxc.overlap})`} hint="Кількість вікон, що перекриваються — більше значення, краща якість, довше обробка.">
                  <input type="range" min={2} max={16} step={1} value={mdxc.overlap}
                    onChange={(e) => setMdxc({ ...mdxc, overlap: Number(e.target.value) })} className="w-full accent-rh-accent" />
                </Field>
              </div>
            )}
          </div>
        )}

        <div className="border-t border-rh-border pt-4 flex items-center justify-end gap-2">
          {disabled && <span className="text-xs text-rh-muted mr-auto">Спочатку завантажте відео</span>}
          {separationError && <span className="text-xs text-red-400 mr-auto">{separationError}</span>}
          {powerShareError && <span className="text-xs text-red-400 mr-auto">{powerShareError}</span>}
          <button onClick={onClose} className="rh-btn-ghost">Скасувати</button>
          <button
            onClick={handleRunClick}
            className="rh-btn-primary text-xs"
            disabled={busy || disabled || mvsepRunDisabled}
          >
            {busy ? <Spinner size={12} /> : null}
            {runLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1" title={hint}>
      <span className="text-[11px] text-rh-text-dim">{label}</span>
      {children}
    </label>
  )
}
