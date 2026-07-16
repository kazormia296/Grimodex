CREATE TABLE IF NOT EXISTS public_report_artifacts (
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  object_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  PRIMARY KEY (scan_id, object_key)
);

CREATE INDEX IF NOT EXISTS idx_public_report_artifacts_scan
  ON public_report_artifacts(scan_id, created_at);
