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
