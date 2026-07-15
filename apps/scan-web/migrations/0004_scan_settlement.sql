ALTER TABLE scan_jobs ADD COLUMN settlement_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_jobs_settlement_id
  ON scan_jobs(settlement_id);
