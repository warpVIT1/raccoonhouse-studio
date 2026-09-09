ALTER TABLE shared_audio_submissions ADD COLUMN fix_message TEXT;

CREATE TABLE IF NOT EXISTS shared_actor_audio_fix_markers (
  id TEXT PRIMARY KEY,
  shared_submission_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  position_seconds REAL NOT NULL,
  color TEXT
);
CREATE INDEX IF NOT EXISTS idx_shared_fix_markers_submission ON shared_actor_audio_fix_markers(shared_submission_id);
