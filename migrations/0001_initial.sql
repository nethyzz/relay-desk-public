PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
INSERT OR IGNORE INTO groups VALUES ('default', '默认分组', 0);
CREATE TABLE IF NOT EXISTS endpoints (
 id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), name TEXT NOT NULL,
 base_url TEXT NOT NULL, key_cipher TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
 id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id), name TEXT NOT NULL,
 protocol TEXT NOT NULL, request_model TEXT NOT NULL, claimed_model TEXT NOT NULL,
 tier TEXT NOT NULL DEFAULT 'medium', created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS schedules (
 target_id TEXT PRIMARY KEY REFERENCES targets(id), enabled INTEGER NOT NULL DEFAULT 0,
 kind TEXT NOT NULL DEFAULT 'interval', interval_minutes INTEGER NOT NULL DEFAULT 360,
 daily_time TEXT NOT NULL DEFAULT '09:00', tier TEXT NOT NULL DEFAULT 'low', next_due INTEGER,
 last_error TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('limits', '{"daily_requests":2000,"monthly_minutes":1500}');
INSERT OR IGNORE INTO settings VALUES ('mail', '{"enabled":false,"mode":"changes","host":"","port":465,"username":"","from":"","to":"","password_cipher":""}');
CREATE TABLE IF NOT EXISTS batches (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'detection', status TEXT NOT NULL DEFAULT 'queued',
 created_at INTEGER NOT NULL, dispatched_at INTEGER, started_at INTEGER, ended_at INTEGER,
 claimed_by TEXT, lease_hash TEXT, lease_until INTEGER, heartbeat_at INTEGER,
 reserved_minutes INTEGER NOT NULL DEFAULT 15, used_minutes INTEGER, error TEXT, last_dispatch_error TEXT,
 mail_payload TEXT
);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), target_id TEXT NOT NULL REFERENCES targets(id),
 status TEXT NOT NULL DEFAULT 'queued', source TEXT NOT NULL, created_at INTEGER NOT NULL,
 started_at INTEGER, ended_at INTEGER, snapshot TEXT NOT NULL, key_cipher TEXT NOT NULL, progress TEXT, report TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, reserved_attempts INTEGER NOT NULL, quota_day TEXT NOT NULL,
 error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_target ON runs(target_id) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS reports_by_target ON runs(target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS due_schedules ON schedules(enabled, next_due);
CREATE INDEX IF NOT EXISTS run_quota ON runs(quota_day);
CREATE INDEX IF NOT EXISTS batch_quota ON batches(created_at);
CREATE TABLE IF NOT EXISTS quota_reservations (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, period TEXT NOT NULL, amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS quota_period ON quota_reservations(kind, period);
CREATE TABLE IF NOT EXISTS notices (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, reference TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, sent_at INTEGER, error TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
