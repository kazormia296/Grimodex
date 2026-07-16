ALTER TABLE scan_sessions ADD COLUMN cleanup_completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_scan_sessions_pending_cleanup
  ON scan_sessions(status, cleanup_completed_at)
  WHERE status = 'deleted';
