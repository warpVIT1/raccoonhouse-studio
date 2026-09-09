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
  shared_id?: string | null
  team_id?: string | null
  team_name?: string | null
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
  subtitle_stage: string
  actor_video_transfer_id?: string | null
  remote_video_transfer_id?: string | null
  original_filename?: string | null
  cleaned_video_transfer_id?: string | null
  cleaned_video_filename?: string | null
  cleaned_video_uploaded_at?: string | null
  cleaned_video_sent_to_sound_engineer_at?: string | null
  shared_id?: string | null
}

export interface Character {
  id: number
  title_id: number
  name: string
  code: string | null
  dubber_id: number | null
  dubber_name?: string
  team_device_id?: string | null
}

// A team member with the 'actor' role, as returned by GET /teams/{id}/actors
// (mirrors the Worker's /team-actors — same source used for the Telegram
// /notify-actors handoff). Feeds the subtitle grid's АКТОР dropdown.
export interface TeamActor {
  device_id: string
  display_name: string
}

export interface Dubber {
  id: number
  name: string
  // Explicit link to a local Profile (see backend Dubber.profile_id) —
  // set once by a director/admin, lets the "actor" role workspace answer
  // "which character is mine".
  profile_id: number | null
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
  source_actor_name?: string | null
  ass_style: string
  is_overlap: boolean
  layer: number
  margin_l: number
  margin_r: number
  margin_v: number
}

export interface Marker {
  id: number
  episode_id: number
  reaper_name: string
  position_seconds: number
  confirmed: boolean
  color?: string | null
  character_id?: number | null
}

export interface ActorAudioSubmission {
  id: number
  episode_id: number
  character_id: number | null
  character_name: string | null
  filename: string
  transfer_id: string
  uploaded_by_name: string
  created_at: string
  fix_requested_at?: string | null
  fix_requested_by_role?: string | null
  sent_to_sound_engineer_at?: string | null
  fix_message?: string | null
  fix_marker_count: number
  fix_of_submission_id?: number | null
  accepted_at?: string | null
  accepted_by_name?: string | null
}

export interface ActorAudioFixMarker {
  id: number
  submission_id: number
  label: string
  position_seconds: number
  color: string | null
}

export interface JobStatus {
  id: string
  type: 'import_video' | 'import_video_remote' | 'separate_vocals' | 'batch_separate_vocals' | 'distributed_separate_vocals' | 'request_remote_separation' | 'export_srt' | 'mux_audio' | 'request_remote_render' | 'install_gpu_runtime' | 'download_model' | 'install_audio_separator_update' | 'mvsep_male_female' | 'export_actor_video' | 'submit_actor_audio' | 'download_original_video' | 'submit_cleaned_video' | 'generate_actor_reaper_project'
  status: 'pending' | 'running' | 'complete' | 'error' | 'cancelled'
  percent: number
  message: string
  episode_id?: number
  result?: Record<string, unknown>
  filename?: string
  fix_of_submission_id?: number
  character_id?: number
}

export interface WsMessage {
  type: 'progress' | 'complete' | 'error' | 'cancelled' | 'status' | 'power_share_request' | 'power_share_lending' | 'power_share_model_download_request' | 'power_share_borrowing' | 'force_update_request' | 'team_invite' | 'shared_content_updated'
  job_id?: string
  percent?: number
  message?: string
  error?: string
  data?: Record<string, unknown>
}

export interface Team {
  id: string
  name: string
  credits_enabled: number
  created_by_device_id: string
  created_at: string
}

export interface MyTeam extends Team {
  is_team_admin: number
}

export interface TeamMember {
  team_id: string
  device_id: string
  display_name: string
  is_team_admin: number
  joined_at: string
  roles: string[]
}

export interface TeamInvite {
  id: string
  team_id: string
  team_name: string
  created_at: string
}

export interface KnownUser {
  device_id: string
  display_name: string
  teams: Array<{ team_id: string; team_name: string; is_team_admin: boolean }>
  credits_enabled: boolean
  // True when credits_enabled comes from being in a credits_enabled team
  // (see team_service.all_known_users) — the manual per-person toggle is
  // moot (and hidden) in that case, since it's already granted automatically.
  credits_from_team: boolean
  telegram_id: number | null
  telegram_username?: string | null
  roles?: string[]
  first_seen_at?: string | null
  last_seen_at?: string | null
}

export interface ErrorReport {
  id: string
  device_id?: string | null
  profile_name: string
  message: string
  stack?: string | null
  context: string
  created_at: string
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
  audio_separator_version: string
  audio_separator_update_version: string | null
  beta_features_enabled: boolean
  device_id: string
  deepl_api_key: string | null
  openai_api_key: string | null
  gemini_api_key: string | null
  sound_engineer_filename_template: string | null
  backup_directory: string | null
}

export interface FeedbackItem {
  id: string
  nickname: string
  device_id?: string | null
  message: string
  created_at: string
}

export interface SeparationReport {
  id: string
  profile_name: string
  device_id?: string | null
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
  // Job-title roles (клінапер/звукорежисер/перекладач/режисер/актор and
  // whatever an admin later adds — see RoleCatalogItem) — several at once,
  // unlike the legacy `role` string above (which stays whatever it was set
  // to, since it's also the unadvertised admin-unlock trigger).
  roles: string[] | null
  color: string
  // Only ever true when set via ProfileModal's "type admin as your role"
  // password flow — see backend Profile.is_admin's comment for why this
  // lives per-profile rather than as a single install-wide flag.
  is_admin: boolean
  // Whether this profile has its own optional password — never the hash
  // itself. Set at creation, see ProfileModal's "Пароль" field.
  has_password: boolean
  // Telegram login — all null for a profile created the old manual way.
  telegram_id: number | null
  telegram_username: string | null
  avatar_url: string | null
}

export interface RoleCatalogItem {
  key: string
  label: string
  sort_order: number
}

export interface TitleRoleAssignment {
  role: string
  device_id: string
  display_name: string
}

export interface EpisodeRoleDeadline {
  role: string
  character_id?: number | null
  deadline?: string | null
}

export interface EpisodeRoleAssignment {
  role: string
  device_id: string
  display_name: string
}

export interface EpisodeAdminPersonStatus {
  role: string
  character_id?: number | null
  character_name?: string | null
  device_id?: string | null
  display_name?: string | null
  status?: string | null
  badges: Record<string, boolean>
  progress?: string | null
  deadline?: string | null
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
