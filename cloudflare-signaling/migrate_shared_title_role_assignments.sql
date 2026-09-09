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
