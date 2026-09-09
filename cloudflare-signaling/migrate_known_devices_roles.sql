-- Adds the columns known_devices needs for the translator -> director
-- Telegram notify handoff (see schema.sql's own comment on this table and
-- the new /notify-director route in src/index.ts). SQLite/D1 has no
-- "ADD COLUMN IF NOT EXISTS" — this is a one-time run against the already
-- already-deployed table, mirroring migrate_unique_filename.sql's precedent.
ALTER TABLE known_devices ADD COLUMN roles TEXT;
ALTER TABLE known_devices ADD COLUMN telegram_id INTEGER;
