ALTER TABLE editor_tokens ADD COLUMN owner_subject TEXT
  CHECK (
    owner_subject IS NULL OR
    (length(owner_subject) BETWEEN 1 AND 128)
  );

ALTER TABLE editor_sessions ADD COLUMN owner_subject TEXT
  CHECK (
    owner_subject IS NULL OR
    (length(owner_subject) BETWEEN 1 AND 128)
  );

-- Preserve ownership for Editor capabilities issued after a Scan was claimed
-- but before this migration was applied. Capabilities whose Scan is still
-- ownerless remain claimable by the first authenticated account presenting
-- the correct token.
UPDATE editor_tokens
SET owner_subject = (
  SELECT scan_sessions.owner_subject
  FROM scan_sessions
  WHERE scan_sessions.id = editor_tokens.scan_id
)
WHERE owner_subject IS NULL
  AND EXISTS (
    SELECT 1
    FROM scan_sessions
    WHERE scan_sessions.id = editor_tokens.scan_id
      AND scan_sessions.owner_subject IS NOT NULL
  );

UPDATE editor_sessions
SET owner_subject = (
  SELECT scan_sessions.owner_subject
  FROM scan_sessions
  WHERE scan_sessions.id = editor_sessions.scan_id
)
WHERE owner_subject IS NULL
  AND EXISTS (
    SELECT 1
    FROM scan_sessions
    WHERE scan_sessions.id = editor_sessions.scan_id
      AND scan_sessions.owner_subject IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_editor_tokens_owner_subject
  ON editor_tokens(owner_subject)
  WHERE owner_subject IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_editor_sessions_owner_subject
  ON editor_sessions(owner_subject)
  WHERE owner_subject IS NOT NULL;
