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
