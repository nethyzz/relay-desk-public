-- Saved selections reference models, independent of their groups or key profiles.
CREATE TABLE IF NOT EXISTS run_presets (
 id TEXT PRIMARY KEY, name TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run_preset_targets (
 preset_id TEXT NOT NULL REFERENCES run_presets(id) ON DELETE CASCADE,
 target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 PRIMARY KEY(preset_id,target_id)
);
