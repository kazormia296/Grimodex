-- A handoff token is one-time. Hosted Editor AI receives a separate scoped
-- credential whose raw value is returned once and whose hash alone is stored.
CREATE TABLE editor_sessions (
  token_hash TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_editor_sessions_scan_expiry
  ON editor_sessions(scan_id, expires_at, revoked_at);
