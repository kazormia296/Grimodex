ALTER TABLE ai_usage_ledger ADD COLUMN settlement_id TEXT;
ALTER TABLE ai_usage_ledger ADD COLUMN request_hash TEXT;
ALTER TABLE ai_usage_ledger ADD COLUMN reservation_id TEXT;
ALTER TABLE ai_usage_ledger ADD COLUMN reserved_units INTEGER;
ALTER TABLE ai_usage_ledger ADD COLUMN bucket_keys_json TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_ledger_settlement_id
  ON ai_usage_ledger(settlement_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_ledger_reservation_id
  ON ai_usage_ledger(reservation_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_ledger_stale_reservations
  ON ai_usage_ledger(status, updated_at)
  WHERE reservation_id IS NOT NULL;
