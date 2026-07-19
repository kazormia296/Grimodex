ALTER TABLE upload_intents ADD COLUMN owner_subject TEXT
  CHECK (
    owner_subject IS NULL OR
    (length(owner_subject) BETWEEN 1 AND 128)
  );

ALTER TABLE scan_sessions ADD COLUMN owner_subject TEXT
  CHECK (
    owner_subject IS NULL OR
    (length(owner_subject) BETWEEN 1 AND 128)
  );

CREATE INDEX IF NOT EXISTS idx_upload_intents_owner_subject
  ON upload_intents(owner_subject)
  WHERE owner_subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scan_sessions_owner_subject
  ON scan_sessions(owner_subject)
  WHERE owner_subject IS NOT NULL;
