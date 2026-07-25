import React, { useState } from 'react'
import { Spinner } from './ui/Spinner'
import { Toggle } from './ui/Toggle'

export const SEPARATION_MODELS = ['MDX-Net', 'VR Arch', 'Demucs', 'MDX23C', 'BS-RoFormer'] as const
export type SeparationModel = typeof SEPARATION_MODELS[number]

type Arch = 'mdx' | 'vr' | 'demucs' | 'mdxc'

// MDX23C and BS-RoFormer are both "mdxc" architecture models in
// audio-separator — same advanced-settings shape, matching backend's
// MODEL_ARCH in services/separator_service.py.
const MODEL_ARCH: Record<SeparationModel, Arch> = {
  'MDX-Net': 'mdx',
  'VR Arch': 'vr',
  Demucs: 'demucs',
  MDX23C: 'mdxc',
  'BS-RoFormer': 'mdxc',
}

// Curated subset of audio-separator's model registry per method — same list
// as backend's MODEL_CHOICES in services/separator_service.py (filenames
// must match exactly). First entry is that method's default.
const MODEL_CHOICES: Record<SeparationModel, { label: string; file: string }[]> = {
  'MDX-Net': [
    { label: 'UVR-MDX-NET Inst HQ 3', file: 'UVR-MDX-NET-Inst_HQ_3.onnx' },
    { label: 'UVR-MDX-NET Inst HQ 4', file: 'UVR-MDX-NET-Inst_HQ_4.onnx' },
    { label: 'UVR-MDX-NET Inst HQ 5', file: 'UVR-MDX-NET-Inst_HQ_5.onnx' },
    { label: 'UVR-MDX-NET Inst Main', file: 'UVR-MDX-NET-Inst_Main.onnx' },
    { label: 'UVR-MDX-NET Voc FT', file: 'UVR-MDX-NET-Voc_FT.onnx' },
    { label: 'Kim Vocal 2', file: 'Kim_Vocal_2.onnx' },
    { label: 'UVR-MDX-NET Karaoke 2', file: 'UVR_MDXNET_KARA_2.onnx' },
    // Tier 1 in the UVR community guide's model tier list.
    { label: 'Kim Inst', file: 'Kim_Inst.onnx' },
    { label: 'UVR-MDX-NET Inst 3', file: 'UVR-MDX-NET-Inst_3.onnx' },
  ],
  'VR Arch': [
    { label: 'UVR-De-Echo-Normal', file: 'UVR-De-Echo-Normal.pth' },
    { label: 'UVR-De-Echo-Aggressive', file: 'UVR-De-Echo-Aggressive.pth' },
    { label: 'UVR-DeEcho-DeReverb', file: 'UVR-DeEcho-DeReverb.pth' },
    { label: '3_HP-Vocal-UVR', file: '3_HP-Vocal-UVR.pth' },
    { label: '4_HP-Vocal-UVR', file: '4_HP-Vocal-UVR.pth' },
    { label: 'UVR-DeNoise', file: 'UVR-DeNoise.pth' },
  ],
  Demucs: [
    { label: 'htdemucs_ft', file: 'htdemucs_ft.yaml' },
    { label: 'htdemucs', file: 'htdemucs.yaml' },
    { label: 'hdemucs_mmi', file: 'hdemucs_mmi.yaml' },
    { label: 'htdemucs_6s', file: 'htdemucs_6s.yaml' },
  ],
  MDX23C: [
    { label: 'MDX23C-InstVoc HQ', file: 'MDX23C-8KFFT-InstVoc_HQ.ckpt' },
    { label: 'MDX23C-InstVoc HQ 2', file: 'MDX23C-8KFFT-InstVoc_HQ_2.ckpt' },
    { label: 'MDX23C De-Reverb', file: 'MDX23C-De-Reverb-aufr33-jarredou.ckpt' },
    // Tier 1 in the UVR community guide's model tier list.
    { label: 'MDX23C D1581', file: 'MDX23C_D1581.ckpt' },
  ],
  'BS-RoFormer': [
    { label: 'BS-Roformer-Viperx-1297', file: 'model_bs_roformer_ep_317_sdr_12.9755.ckpt' },
    { label: 'BS-Roformer-Viperx-1296', file: 'model_bs_roformer_ep_368_sdr_12.9628.ckpt' },
    { label: 'Mel-Roformer-Viperx-1143', file: 'model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt' },
    { label: 'MelBand Roformer Kim FT 3 (unwa)', file: 'mel_band_roformer_kim_ft3_unwa.ckpt' },
    { label: 'MelBand Roformer Vocals (becruily)', file: 'mel_band_roformer_vocals_becruily.ckpt' },
    { label: 'MelBand Roformer Instrumental (Gabox)', file: 'mel_band_roformer_instrumental_gabox.ckpt' },
  ],
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
  const [model, setModel] = useState<SeparationModel>('MDX-Net')
  const [ensemble, setEnsemble] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  // Mutually exclusive with each other (not with ensemble/batch) — asking one
  // peer for its whole power vs. splitting across every available peer are
  // two different modes of the same underlying action, never both at once.
  const [requestPowerMode, setRequestPowerMode] = useState(false)
  const [distributedMode, setDistributedMode] = useState(false)
  const [modelFile, setModelFile] = useState(MODEL_CHOICES['MDX-Net'][0].file)
  const [mdx, setMdx] = useState(DEFAULT_MDX)
  const [vr, setVr] = useState(DEFAULT_VR)
  const [demucs, setDemucs] = useState(DEFAULT_DEMUCS)
  const [mdxc, setMdxc] = useState(DEFAULT_MDXC)

  const arch = MODEL_ARCH[model]

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
    setModelFile(MODEL_CHOICES[m][0].file)
  }

  function buildParams(): SeparationParams | undefined {
    // Ensemble runs all 5 models — per-model overrides don't map cleanly
    // onto that, so it always uses the library's own defaults.
    if (ensemble) return undefined
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
    if (batchMode) { onRunBatch(); return }
    if (distributedMode) { onRunDistributed(model, ensemble, ensemble ? undefined : modelFile, buildParams()); return }
    if (requestPowerMode) { onRequestPower(model, ensemble, ensemble ? undefined : modelFile, buildParams()); return }
    onRun(model, ensemble, ensemble ? undefined : modelFile, buildParams())
  }

  const runLabel = batchMode
    ? 'Запустити пакетний рендер'
    : distributedMode
    ? 'Запустити розподілену обробку'
    : requestPowerMode
    ? 'Запросити потужність'
    : 'Запустити'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="rh-card w-[620px] max-h-[85vh] overflow-y-auto p-6 flex flex-col gap-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Ізоляція вокалу</h2>
          <button onClick={onClose} className="text-rh-muted hover:text-white text-lg leading-none px-1">✕</button>
        </div>

        {/* Method picker */}
        <div className="flex flex-col gap-2">
          <span className="text-xs text-rh-muted">Метод</span>
          <div className="grid grid-cols-5 gap-1.5">
            {SEPARATION_MODELS.map((m) => (
              <button
                key={m}
                onClick={() => selectMethod(m)}
                disabled={ensemble}
                className={`px-2 py-2 rounded-lg text-xs font-medium transition-colors border
                  ${model === m && !ensemble ? 'bg-rh-accent text-white border-rh-accent' : 'text-rh-muted border-rh-border hover:text-rh-text hover:border-rh-border2'}
                  ${ensemble ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {m}
              </button>
            ))}
          </div>
          {!ensemble && (
            <Field label="Модель" hint="Конкретний чекпоінт цього методу — впливає на якість і швидкість.">
              <select className="rh-input" value={modelFile} onChange={(e) => setModelFile(e.target.value)}>
                {MODEL_CHOICES[model].map((c) => <option key={c.file} value={c.file}>{c.label}</option>)}
              </select>
            </Field>
          )}
          <Toggle
            checked={ensemble}
            onChange={setEnsemble}
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

        {/* Advanced settings — per architecture, UVR5-style */}
        {!ensemble && (
          <div className="border-t border-rh-border pt-4 flex flex-col gap-3">
            <span className="text-xs text-rh-muted">Розширені налаштування ({model})</span>

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
