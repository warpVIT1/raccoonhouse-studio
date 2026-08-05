export type TitleStatus = 'new' | 'in_progress' | 'done'
export type EpisodeStatus =
  | 'not_uploaded'
  | 'processing'
  | 'vocal_isolated'
  | 'marked'
  | 'ready'

export interface Title {
  id: number
  name_ua: string
  name_original: string
  poster_path: string | null
  status: TitleStatus
  episode_count?: number
}

export interface Episode {
  id: number
  title_id: number
  season: number
  number: number
  duration: number | null
  original_file_path: string | null
  original_size: number | null
  original_bitrate: number | null
  original_format: string | null
  status: EpisodeStatus
  created_at: string
  vocal_stem_path?: string | null
  subtitle_count?: number
}

export interface Character {
  id: number
  title_id: number
  name: string
  code: string | null
  dubber_id: number | null
  dubber_name?: string
}

export interface Dubber {
  id: number
  name: string
}

export interface CharacterDubberMap {
  character_id: number
  dubber_id: number
  title_id: number
}

export interface SubtitleLine {
  id: number
  episode_id: number
  start_ms: number
  end_ms: number
  text: string
  character_id: number | null
  character_name?: string
  ass_style: string
  is_overlap: boolean
}

export interface Marker {
  id: number
  episode_id: number
  reaper_name: string
  position_seconds: number
  confirmed: boolean
  color?: string | null
}

export interface JobStatus {
  id: string
  type: 'import_video' | 'import_video_remote' | 'separate_vocals' | 'batch_separate_vocals' | 'distributed_separate_vocals' | 'request_remote_separation' | 'detect_markers' | 'export_srt' | 'mux_audio' | 'request_remote_render' | 'install_gpu_runtime' | 'download_model'
  status: 'pending' | 'running' | 'complete' | 'error' | 'cancelled'
  percent: number
  message: string
  episode_id?: number
  result?: Record<string, unknown>
}

export interface WsMessage {
  type: 'progress' | 'complete' | 'error' | 'cancelled' | 'status' | 'power_share_request' | 'power_share_lending' | 'power_share_model_download_request' | 'power_share_borrowing' | 'force_update_request'
  job_id?: string
  percent?: number
  message?: string
  error?: string
  data?: Record<string, unknown>
}

export interface SignStylesConfig {
  title_id: number
  style_names: string[]
}

export interface ReaperExportOptions {
  position_format: 'time' | 'bars_beats'
  bpm?: number
}

export interface AppSettings {
  reaper_path: string | null
  separation_model: string
  ensemble_default: boolean
  position_format: 'time' | 'bars_beats'
  default_bpm: number | null
  available_models: string[]
  active_profile_id: number | null
  active_profile: Profile | null
  power_share_enabled: boolean
  power_share_auto_approve: boolean
  online_signaling_enabled: boolean
  online_signaling_url: string | null
  show_feedback_inbox: boolean
  gpu_enabled: boolean
  gpu_available: boolean
  gpu_runtime_installed: boolean
}

export interface FeedbackItem {
  id: string
  nickname: string
  message: string
  created_at: string
}

export interface SeparationReport {
  id: string
  profile_name: string
  user_timezone: string
  episode_label: string
  model: string
  ensemble: boolean
  distributed: boolean
  peers_used: string[]
  duration_seconds: number
  status: string
  error_message: string | null
  warnings: string[]
  started_at_utc: string
  created_at: string
}

export interface Profile {
  id: number
  name: string
  role: string
  color: string
  // Only ever true when set via ProfileModal's "type admin as your role"
  // password flow — see backend Profile.is_admin's comment for why this
  // lives per-profile rather than as a single install-wide flag.
  is_admin: boolean
}

export interface PowerShareRequestPayload {
  request_id: string
  requester_name: string
  title_name: string
  episode_number: number
  task: 'separate' | 'import' | 'render'
  timeout_seconds: number
}

export interface PowerShareModelDownloadPayload {
  request_id: string
  requester_name: string
  title_name: string
  episode_number: number
  filename: string
  timeout_seconds: number
}

export interface PowerShareLendingPayload {
  active: boolean
  task: 'separate' | 'import' | 'render'
  requester_name: string
  title_name: string
  episode_number: number
  percent?: number | null
  message?: string | null
}

export interface PowerShareBorrowingPayload {
  active: boolean
  task?: 'separate' | 'import' | 'render'
  peer_name?: string
  title_name?: string
  episode_number?: number
  percent?: number | null
  message?: string | null
}

export interface ModelChoice {
  label: string
  file: string
  custom: boolean
  id?: number | null
}

export interface ModelsConfig {
  methods: string[]
  choices: Record<string, ModelChoice[]>
}

export interface ApexModelItem {
  id: number
  method: string
  label: string
  filename: string
  arch: string
}

export interface ModelDescription {
  filename: string
  description: string
  updated_by: string
  updated_at: string
}

export interface PersonalEnsembleModelItem {
  id: number
  method: string
  label: string
  filename: string
  arch: string
}

export interface RegistryEntry {
  label: string
  filename: string
  stems: string[]
  is_vocal_separator: boolean | null
}

// A model added to the shared Model Browser catalog via "add by URL" (see
// backend/routers/model_browser.py's /catalog, backed by Cloudflare D1 —
// NOT audio-separator's own registry, see RegistryEntry above for that).
export interface CatalogModel {
  id: string
  method: string
  filename: string
  label: string
  arch: string
  download_url: string
  config_yaml_url: string | null
  source_url: string
  added_by: string
  notes: string | null
  created_at: string
}

// The AI's proposed configuration for a submitted repo URL, before the user
// reviews/edits and confirms it into the shared catalog (see /models/submit
// and /models/confirm).
export interface ModelProposal {
  method: string
  arch: string
  filename: string
  download_url: string | null
  config_yaml_url: string | null
  label: string
  stems: string[]
  confidence: 'high' | 'medium' | 'low'
  source_url: string
  download_url_ok: boolean
  config_yaml_url_ok: boolean
}

export interface ModelRating {
  method: string
  filename: string
  profile_name: string
  rating: number
}

export interface HikkaAnimeResult {
  slug: string | null
  title_ua: string | null
  title_en: string | null
  title_ja: string | null
  image: string | null
  episodes_total: number | null
  status: string | null
}
