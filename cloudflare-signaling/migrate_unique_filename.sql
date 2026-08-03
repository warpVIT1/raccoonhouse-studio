-- The same physical checkpoint file can never legitimately belong to two
-- different methods — but the old (method, filename) unique index let the
-- AI's own occasionally-inconsistent method classification (confirmed live:
-- the same "inst_gabox.ckpt" got submitted once as "BS-RoFormer" and once
-- as "MDX-Net") create duplicate-looking catalog rows for what's actually
-- one model. Filename alone is the real identity.
DROP INDEX IF EXISTS idx_models_method_filename;
CREATE UNIQUE INDEX IF NOT EXISTS idx_models_filename ON models(filename);
