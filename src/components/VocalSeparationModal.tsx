import React, { useEffect, useState } from 'react'
import { Spinner } from './ui/Spinner'
import { Toggle } from './ui/Toggle'
import { useApi } from '../hooks/useApi'
import { useBackdropClose } from '../hooks/useBackdropClose'
import type { ApexModelItem, AppSettings, ModelsConfig } from '../types'

// "Апекс" is a 6th, ensemble-only pseudo-method — no checkpoint dropdown or
// per-architecture advanced settings of its own (see isApex below and
// backend's APEX_MODELS_DEFAULT in services/separator_service.py for the
// seed line-up). The actual line-up is DB-backed and live-editable from
// this modal (see the apexModels state below) — no rebuild needed to change it.
export const SEPARATION_MODELS = ['MDX-Net', 'VR Arch', 'Demucs', 'MDX23C', 'BS-RoFormer', 'Апекс'] as const
export type SeparationModel = typeof SEPARATION_MODELS[number]

type Arch = 'mdx' | 'vr' | 'demucs' | 'mdxc'

// MDX23C and BS-RoFormer are both "mdxc" architecture models in
// audio-separator — same advanced-settings shape, matching backend's
// MODEL_ARCH in services/separator_service.py. "Апекс" never actually reads
// this (its advanced-settings/model-select UI is hidden entirely, see
// isApex below) — the entry only exists to satisfy the Record's type.
const MODEL_ARCH: Record<SeparationModel, Arch> = {
  'MDX-Net': 'mdx',
  'VR Arch': 'vr',
  Demucs: 'demucs',
  MDX23C: 'mdxc',
  'BS-RoFormer': 'mdxc',
  Апекс: 'mdxc',
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
  onRunBatch: () => void
  onRunDistributed: (model: SeparationModel, ensemble: boolean, modelFile?: string, params?: SeparationParams) => void
  separating: boolean
  requestingPower: boolean
  batchRendering: boolean
  distributedRunning: boolean
  powerShareEnabled: boolean
  powerShareError: string | null
  separationError: string | null
  disabled: boolean
}

export function VocalSeparationModal({
  onClose, onRun, onRequestPower, onRunBatch, onRunDistributed, separating, requestingPower,
  batchRendering, distributedRunning, powerShareEnabled, powerShareError, separationError, disabled,
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
  }

  // "Свої моделі" — a shortcut picker over every custom/Model Browser model
  // already downloaded on this install, spanning every method at once, so
  // picking one doesn't require first remembering which method category it
  // belongs to. Not a real method itself: choosing one just resolves to the
  // model's actual method + file via the normal selectMethod/setModelFile
  // path below and drops back into the regular per-method view, so every
  // other piece of run logic (buildParams, handleRunClick) needs no changes.
  const [showOwnModels, setShowOwnModels] = useState(false)
  const ownModels = SEPARATION_MODELS.filter((m) => m !== 'Апекс').flatMap((m) =>
    (modelsConfig?.choices[m] ?? []).filter((c) => c.custom).map((c) => ({ method: m, ...c }))
  )

  function buildParams(): SeparationParams | undefined {
    // Ensemble runs all 5 default models spanning every architecture —
    // a single settings panel can't map cleanly onto that, so it always
    // uses the library's own defaults. Апекс, unlike Ensemble, is
    // predominantly mdxc-architecture (BS-Roformer/MDX23C/MelBand — only
    // Kim Vocal 2 in the line-up is mdx) and its cleanup pass is mdxc too
    // (see backend's _apex_cleanup_pass), so the mdxc segment/overlap
    // controls below apply meaningfully to it and are sent through.
    if (ensemble) return undefined
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
    const file = ensemble || isApex ? undefined : modelFile
    if (batchMode) { onRunBatch(); return }
    if (distributedMode) { onRunDistributed(model, ensemble, file, buildParams()); return }
    if (requestPowerMode) { onRequestPower(model, ensemble, file, buildParams()); return }
    onRun(model, ensemble, file, buildParams())
  }

  const runLabel = batchMode
    ? 'Запустити пакетний рендер'
    : distributedMode
    ? 'Запустити розподілену обробку'
    : requestPowerMode
    ? 'Запросити потужність'
    : 'Запустити'

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
          <div className="grid grid-cols-7 gap-1.5">
            {SEPARATION_MODELS.map((m) => {
              const isApexButton = m === 'Апекс'
              const active = model === m && !ensemble && !showOwnModels
              return (
                <button
                  key={m}
                  onClick={() => { setShowOwnModels(false); selectMethod(m) }}
                  disabled={ensemble}
                  title={isApexButton ? 'Кураторський ансамбль найсильніших моделей — для максимально чистого результату' : undefined}
                  className={`px-2 py-2 rounded-lg text-xs font-medium transition-colors border
                    ${active
                      ? isApexButton
                        ? 'bg-gradient-to-br from-amber-400 to-amber-600 text-black border-amber-400'
                        : 'bg-rh-accent text-white border-rh-accent'
                      : isApexButton
                        ? 'text-amber-400 border-amber-500/40 hover:text-amber-300 hover:border-amber-400/60'
                        : 'text-rh-muted border-rh-border hover:text-rh-text hover:border-rh-border2'}
                    ${ensemble ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  {isApexButton ? '★ Апекс' : m}
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
                    {SEPARATION_MODELS.filter((m) => m !== 'Апекс').map((m) => <option key={m} value={m}>{m}</option>)}
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
          {!ensemble && !isApex && !showOwnModels && (
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
          <Toggle
            checked={ensemble}
            // Ensemble Mode's "one default per broad method" and Апекс's own
            // fixed 5-model set are two different, mutually exclusive
            // ensembles — switching one on while Апекс is selected would
            // otherwise silently run the generic ensemble instead, ignoring
            // the Апекс pick with no visible explanation.
            onChange={(v) => { setEnsemble(v); if (v && isApex) setModel(SEPARATION_MODELS[0]) }}
            className="mt-1"
            label="Ensemble Mode — запустити всі 5 методів і усереднити результат (повільніше, типові моделі й налаштування для кожного)"
          />
          <Toggle
            checked={batchMode}
            onChange={setBatchMode}
            label="Пакетний рендер — запустити всі 5 методів, кожен результат окремим файлом (без усереднення)"
          />
          {powerShareEnabled && (
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
        {!ensemble && (
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
            disabled={busy || disabled}
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
