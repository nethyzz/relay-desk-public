-- Retain an idempotency receipt, never credentials or copied report contents.
CREATE TABLE target_clone_requests (
 id TEXT PRIMARY KEY,
 request_hash TEXT NOT NULL,
 result TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
