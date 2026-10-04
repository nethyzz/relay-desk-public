-- Logical selections can reuse runs from more than one execution batch.
CREATE TABLE IF NOT EXISTS run_sets (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, created_at INTEGER NOT NULL,
 ended_at INTEGER, superseded_by TEXT
);
CREATE TABLE IF NOT EXISTS run_set_members (
 set_id TEXT NOT NULL REFERENCES run_sets(id), run_id TEXT NOT NULL REFERENCES runs(id),
 PRIMARY KEY(set_id, run_id)
);
CREATE INDEX IF NOT EXISTS run_sets_waiting ON run_sets(ended_at);
CREATE INDEX IF NOT EXISTS run_sets_by_run ON run_set_members(run_id);

-- Preserve old task/report identities and combine any unsent per-run notices.
INSERT OR IGNORE INTO run_sets(id,source,created_at,ended_at)
 SELECT b.id,COALESCE((SELECT source FROM runs WHERE batch_id=b.id LIMIT 1),'manual'),b.created_at,
 CASE WHEN (b.status IN ('completed','failed') AND NOT EXISTS(
  SELECT 1 FROM notices n JOIN runs r ON n.reference=r.id
  WHERE r.batch_id=b.id AND n.kind='run' AND n.status='pending'
 )) OR EXISTS(SELECT 1 FROM notices n JOIN runs r ON r.id=n.reference WHERE r.batch_id=b.id AND n.kind='run' AND n.status='processing')
 THEN COALESCE(b.ended_at,b.created_at) ELSE NULL END
 FROM batches b WHERE b.kind='detection';
INSERT OR IGNORE INTO run_set_members(set_id,run_id) SELECT batch_id,id FROM runs;
UPDATE notices SET status='cancelled' WHERE kind='run' AND status='pending';
