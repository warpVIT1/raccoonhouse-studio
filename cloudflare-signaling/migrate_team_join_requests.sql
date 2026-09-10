-- User-initiated join requests via the Telegram bot (`join <team_id>`),
-- distinct from team_invites (admin-initiated, by device_id). See
-- schema.sql's own comment on this table for the full flow.
CREATE TABLE IF NOT EXISTS team_join_requests (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  telegram_id INTEGER,
  telegram_username TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_team_join_requests_team ON team_join_requests(team_id);
