-- Existing preview deployments may already have 0001 applied. Access tokens
-- keep scan ids from being sufficient to read private reports or mutate jobs.
ALTER TABLE scan_sessions ADD COLUMN access_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_sessions_access_token ON scan_sessions(access_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_public_reports_scan ON public_reports(scan_id);
