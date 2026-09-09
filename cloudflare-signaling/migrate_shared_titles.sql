-- One-time migration for the already-deployed D1 database — adds the
-- shared_titles/shared_episodes/shared_characters/shared_subtitle_lines
-- tables (see schema.sql's own comment on these). Mirrors
-- migrate_known_devices_roles.sql's precedent: CREATE TABLE/INDEX
-- IF NOT EXISTS is safe to run once against a live database that doesn't
-- have these tables yet.

CREATE TABLE IF NOT EXISTS shared_titles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name_ua TEXT NOT NULL,
  name_original TEXT NOT NULL,
  poster_transfer_id TEXT,
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
  video_transfer_id TEXT,
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
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_characters_title ON shared_characters(shared_title_id);

CREATE TABLE IF NOT EXISTS shared_subtitle_lines (
  id TEXT PRIMARY KEY,
  shared_episode_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  character_id TEXT,
  ass_style TEXT NOT NULL DEFAULT 'Default',
  is_overlap INTEGER NOT NULL DEFAULT 0,
  layer INTEGER NOT NULL DEFAULT 0,
  margin_l INTEGER NOT NULL DEFAULT 0,
  margin_r INTEGER NOT NULL DEFAULT 0,
  margin_v INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_subtitle_lines_episode ON shared_subtitle_lines(shared_episode_id);
