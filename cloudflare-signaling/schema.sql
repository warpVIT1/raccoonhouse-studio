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
