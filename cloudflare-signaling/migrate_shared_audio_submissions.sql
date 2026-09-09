CREATE TABLE IF NOT EXISTS shared_audio_submissions (
  id TEXT PRIMARY KEY,
  shared_episode_id TEXT NOT NULL,
  character_id TEXT,
  filename TEXT NOT NULL,
  transfer_id TEXT NOT NULL,
  uploaded_by_device_id TEXT,
  uploaded_by_name TEXT NOT NULL DEFAULT '?',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shared_audio_submissions_episode ON shared_audio_submissions(shared_episode_id);
