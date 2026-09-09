CREATE TABLE IF NOT EXISTS shared_markers (
  id TEXT PRIMARY KEY,
  shared_episode_id TEXT NOT NULL,
  reaper_name TEXT NOT NULL,
  position_seconds REAL NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  character_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_markers_episode ON shared_markers(shared_episode_id);
