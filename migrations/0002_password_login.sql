CREATE TABLE IF NOT EXISTS login_limits (
 bucket TEXT PRIMARY KEY,
 attempts INTEGER NOT NULL DEFAULT 0,
 reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_limits_expiry ON login_limits(reset_at);
