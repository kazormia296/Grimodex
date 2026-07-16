ALTER TABLE public_report_artifacts ADD COLUMN cleanup_claimed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_public_report_artifacts_pending_cleanup
  ON public_report_artifacts(published_at, cleanup_claimed_at, created_at);
