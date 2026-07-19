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
  proxy_480p_path: string | null
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
}

export interface JobStatus {
  id: string
  type: 'import_video' | 'import_video_remote' | 'separate_vocals' | 'request_remote_separation' | 'detect_markers' | 'export_srt' | 'mux_audio'
  status: 'pending' | 'running' | 'complete' | 'error' | 'cancelled'
  percent: number
  message: string
  episode_id?: number
  result?: Record<string, unknown>
}

export interface WsMessage {
  type: 'progress' | 'complete' | 'error' | 'status' | 'power_share_request' | 'power_share_lending'
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
  cache_dir: string | null
  available_models: string[]
  active_profile_id: number | null
  active_profile: Profile | null
  power_share_enabled: boolean
  manual_peer_host: string | null
  manual_peer_port: number
}

export interface CacheInfo {
  cache_dir: string
  size_bytes: number
  size_label: string
  file_count: number
}

export interface Profile {
  id: number
  name: string
  role: string
  color: string
}

export interface PowerShareRequestPayload {
  request_id: string
  requester_name: string
  title_name: string
  episode_number: number
  task: 'separate' | 'import'
  timeout_seconds: number
}

export interface PowerShareLendingPayload {
  active: boolean
  task: 'separate' | 'import'
  requester_name: string
  title_name: string
  episode_number: number
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
