-- Model Browser's shared catalog + ratings — the single source of truth
-- every RaccoonHouse install reads from and writes to (see
-- backend/routers/model_browser.py and ModelBrowserModal.tsx). Two kinds of
-- rows live in `models`: audio-separator's own built-in registry entries
-- ARE NOT duplicated here (those are read straight from the Python library
-- at runtime, see separator_service.registry_entries_for_method) — this
-- table only holds models added by hand or via the "add by URL" AI
-- auto-configure flow (is_custom = 1 always, kept as a real column anyway
-- in case a future admin-curated built-in override is ever needed).

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  filename TEXT NOT NULL,
  label TEXT NOT NULL,
  arch TEXT NOT NULL,
  download_url TEXT NOT NULL,
  config_yaml_url TEXT,
  source_url TEXT NOT NULL,
  added_by TEXT NOT NULL,
  is_custom INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- Filename alone, not (method, filename) — the same physical checkpoint
-- file can never legitimately belong to two different methods, but the AI
-- auto-configure step's own method classification isn't perfectly
-- consistent between separate analysis runs of the same repo (confirmed
-- live: the same file submitted once as "BS-RoFormer", once as "MDX-Net").
-- Keying on (method, filename) let that create duplicate-looking catalog
-- rows for what's actually one model; filename is the real identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_models_filename ON models(filename);

CREATE TABLE IF NOT EXISTS model_ratings (
  method TEXT NOT NULL,
  filename TEXT NOT NULL,
  profile_name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (method, filename, profile_name)
);

-- Free-text "pros/cons" note per model, shared studio-wide and editable by
-- ANY profile (unlike ratings, which are per-profile) — a single
-- last-write-wins row per filename, not a moderated history. Filename alone,
-- same identity reasoning as idx_models_filename above and covering BOTH
-- registry models and catalog models (this table is keyed independently of
-- the `models` table's own id, since registry models have no row there at
-- all).
CREATE TABLE IF NOT EXISTS model_descriptions (
  filename TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Team system (see backend/services/team_service.py, src/index.ts's /teams
-- routes). device_id is the fixed per-machine id from
-- backend/services/device_identity_service.py — never a local Profile row,
-- which can get wiped independently of team membership. Only the app admin
-- (a hardcoded device_id allowlist in team_service.py, currently just the
-- one person) can create a team; team creation makes its creator the first
-- team admin automatically.
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  credits_enabled INTEGER NOT NULL DEFAULT 0,
  created_by_device_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_team_admin INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (team_id, device_id)
);

-- A team admin invites by device_id (not by name/email — nothing else is
-- stable enough, see device_identity_service.py's own reasoning). Delivered
-- two ways: immediately over the existing WS relay if the invited device is
-- online right now (see discovery_service._handle_relay's "team_invite"
-- kind), and durably here so it's still waiting the next time they connect
-- if they were offline when invited.
CREATE TABLE IF NOT EXISTS team_invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  invited_device_id TEXT NOT NULL,
  created_by_device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);

-- Per-person credit-access override, independent of team membership — a
-- credits_enabled=1 team only makes credit usage POSSIBLE for its members,
-- the app admin still has to individually flip this per device_id for it to
-- actually work (see team_service.py). Not auto-populated by anything; the
-- app admin grants/revokes it explicitly from the "Користувачі" tab.
CREATE TABLE IF NOT EXISTS credit_grants (
  device_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  granted_by_device_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every profile-scoped device id that's ever said "hello" to the signaling
-- Worker while online — the only "who has ever used this app" registry that
-- exists, since there's no login/registration system. Feeds the app-admin
-- "Користувачі" tab (see team_service.all_known_users), which shows
-- literally everyone here, not just team members — team_members is cross-
-- referenced separately to show a team name next to whoever has one.
-- Upserted best-effort on every "hello" (see src/index.ts's webSocketMessage),
-- never blocking the hello/presence flow if it fails.
CREATE TABLE IF NOT EXISTS known_devices (
  device_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  -- Job-title roles (JSON array, e.g. '["translator"]' — same shape as the
  -- local Profile.roles column) and Telegram chat id, upserted best-effort
  -- on every "hello" same as the columns above. Lets /notify-director find
  -- "teammates with role X who have Telegram linked" via a plain join
  -- against team_members, without a dedicated sync channel.
  roles TEXT,
  telegram_id INTEGER,
  -- Telegram @username (display-only, unlike telegram_id which is what
  -- actually addresses a chat) — synced the same best-effort way, feeds the
  -- admin "База даних" tab's user list.
  telegram_username TEXT
);

-- Shared titles: the cloud-authoritative copy of a Title (+ its episodes/
-- characters/subtitle-lines) for teams that opt a title into team-wide
-- sharing (see backend/services/sync_service.py). Every local install in
-- the team mirrors these into its own local Title/Episode/Character/
-- SubtitleLine rows (matched by the `shared_id` column added to each of
-- those local tables), pushing local edits up and pulling remote ones down
-- — see sync_service.py's own docstring for the full push/pull/notify
-- round trip. TEXT/uuid ids here (not local autoincrement) so independently
-- -created local rows never collide once pushed into one shared table.
-- Conflict handling is last-write-wins by updated_at, no merge — same
-- trust model as every other shared table in this schema (models,
-- model_ratings, etc. have no real conflict resolution either).
CREATE TABLE IF NOT EXISTS shared_titles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name_ua TEXT NOT NULL,
  name_original TEXT NOT NULL,
  poster_transfer_id TEXT,   -- R2 key (see /transfer/:id routes), nullable
  status TEXT NOT NULL DEFAULT 'new',
  show_key TEXT,
  created_by_device_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_titles_team ON shared_titles(team_id);

CREATE TABLE IF NOT EXISTS shared_episodes (
  id TEXT PRIMARY KEY,
  shared_title_id TEXT NOT NULL,
  season INTEGER NOT NULL DEFAULT 1,
  number INTEGER NOT NULL,
  duration REAL,
  video_transfer_id TEXT,    -- R2 key for the raw video, nullable until uploaded
  actor_video_transfer_id TEXT,  -- R2 key for the 480p hardsub proxy actors download, mirrors backend Episode.actor_video_transfer_id
  original_filename TEXT,    -- plain filename as the importer's OS saw it, mirrors backend Episode.original_filename
  translation_started_at TEXT,   -- mirrors backend Episode.translation_started_at (Адмін tab's translator status)
  sound_engineer_done_at TEXT,   -- mirrors backend Episode.sound_engineer_done_at
  cleaned_video_transfer_id TEXT,  -- R2 key for клінапер's uploaded result, mirrors backend Episode.cleaned_video_transfer_id
  cleaned_video_filename TEXT,
  cleaned_video_uploaded_at TEXT,
  original_size INTEGER,
  original_bitrate INTEGER,
  original_format TEXT,
  status TEXT NOT NULL DEFAULT 'not_uploaded',
  subtitle_stage TEXT NOT NULL DEFAULT 'translating',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_episodes_title ON shared_episodes(shared_title_id);

CREATE TABLE IF NOT EXISTS shared_characters (
  id TEXT PRIMARY KEY,
  shared_title_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  team_device_id TEXT,      -- which real team actor voices this character, mirrors backend Character.team_device_id
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_characters_title ON shared_characters(shared_title_id);

-- Sound-engineer/director-placed markers, mirrors backend Marker exactly —
-- see backend/services/sync_service.py's push_markers/pull_and_merge and
-- reaper_exporter.py's per-actor CSV/ReaScript export, which used to have
-- nothing to filter for an actor on a different install (markers never
-- synced at all before this table existed).
CREATE TABLE IF NOT EXISTS shared_markers (
  id TEXT PRIMARY KEY,
  shared_episode_id TEXT NOT NULL,
  reaper_name TEXT NOT NULL,
  position_seconds REAL NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  character_id TEXT,        -- shared_characters.id, nullable
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_markers_episode ON shared_markers(shared_episode_id);

-- Who currently holds a non-actor studio role (director/translator/
-- sound_engineer/etc.) for a shared title — mirrors backend
-- TitleRoleAssignment. One row per (shared_title_id, role), upserted the
-- same "flip one field on a composite key" way team_members.is_team_admin
-- already is.
CREATE TABLE IF NOT EXISTS shared_title_role_assignments (
  id TEXT PRIMARY KEY,
  shared_title_id TEXT NOT NULL,
  role TEXT NOT NULL,
  device_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shared_title_id, role)
);
CREATE INDEX IF NOT EXISTS idx_shared_title_role_assignments_title ON shared_title_role_assignments(shared_title_id);

-- Per-episode deadline for one role's work — mirrors backend
-- EpisodeRoleDeadline. character_id is set only for the actor role (one
-- deadline per actor on this episode); null for the singular roles.
CREATE TABLE IF NOT EXISTS shared_episode_role_deadlines (
  id TEXT PRIMARY KEY,
  shared_episode_id TEXT NOT NULL,
  role TEXT NOT NULL,
  character_id TEXT,
  deadline TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (shared_episode_id, role, character_id)
);
CREATE INDEX IF NOT EXISTS idx_shared_episode_role_deadlines_episode ON shared_episode_role_deadlines(shared_episode_id);

-- Episode-level override of a title's role assignment — mirrors backend
-- EpisodeRoleAssignment. Same shape as shared_title_role_assignments, one
-- level down; resolution order (episode override, then title default) is
-- entirely a backend/frontend concern, not enforced here.
CREATE TABLE IF NOT EXISTS shared_episode_role_assignments (
  id TEXT PRIMARY KEY,
  shared_episode_id TEXT NOT NULL,
  role TEXT NOT NULL,
  device_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shared_episode_id, role)
);
CREATE INDEX IF NOT EXISTS idx_shared_episode_role_assignments_episode ON shared_episode_role_assignments(shared_episode_id);

-- An actor's "Здати" audio-track upload, mirrors backend
-- ActorAudioSubmission — additive (no bulk-replace like markers/lines,
-- each row is one independently uploaded file) with explicit delete
-- propagation, see backend/services/sync_service.py's
-- push_actor_audio_submission/pull_and_merge.
CREATE TABLE IF NOT EXISTS shared_audio_submissions (
  id TEXT PRIMARY KEY,
  shared_episode_id TEXT NOT NULL,
  character_id TEXT,        -- shared_characters.id, nullable
  filename TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  uploaded_by_device_id TEXT,
  uploaded_by_name TEXT NOT NULL DEFAULT '?',
  created_at TEXT NOT NULL,
  fix_requested_at TEXT,        -- mirrors backend ActorAudioSubmission.fix_requested_at
  fix_requested_by_role TEXT,   -- "director" or "sound_engineer"
  sent_to_sound_engineer_at TEXT,
  fix_message TEXT,             -- mirrors backend ActorAudioSubmission.fix_message
  fix_of_submission_id TEXT,    -- shared_audio_submissions.id of the ORIGINAL being fixed, nullable
  accepted_at TEXT,             -- director's sign-off on a fix re-take
  accepted_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_shared_audio_submissions_episode ON shared_audio_submissions(shared_episode_id);

CREATE TABLE IF NOT EXISTS shared_actor_audio_fix_markers (
  id TEXT PRIMARY KEY,
  shared_submission_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  position_seconds REAL NOT NULL,
  color TEXT
);
CREATE INDEX IF NOT EXISTS idx_shared_fix_markers_submission ON shared_actor_audio_fix_markers(shared_submission_id);

CREATE TABLE IF NOT EXISTS shared_subtitle_lines (
  id TEXT PRIMARY KEY,
  shared_episode_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  character_id TEXT,        -- shared_characters.id, nullable
  ass_style TEXT NOT NULL DEFAULT 'Default',
  is_overlap INTEGER NOT NULL DEFAULT 0,
  layer INTEGER NOT NULL DEFAULT 0,
  margin_l INTEGER NOT NULL DEFAULT 0,
  margin_r INTEGER NOT NULL DEFAULT 0,
  margin_v INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Single-row global kill switch for the Telegram stage-handoff/direct-
-- message notifications (see index.ts's notifyTeamRole + /notify-device) —
-- an app admin can pause them app-wide (e.g. to stop pinging everyone
-- during a burst of testing) without touching each team/device individually.
-- Deliberately does NOT gate /feedback, /reports, or the pause/resume
-- announcement itself — see PUT /notification-settings's own comment.
CREATE TABLE IF NOT EXISTS notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_subtitle_lines_episode ON shared_subtitle_lines(shared_episode_id);
