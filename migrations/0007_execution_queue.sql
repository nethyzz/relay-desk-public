ALTER TABLE batches ADD COLUMN dispatch_started_at INTEGER;
CREATE INDEX IF NOT EXISTS batch_queue ON batches(status, created_at);
