-- Rebuild scan_jobs for databases that applied 0001 before the explicit
-- adjudication stage was added. SQLite cannot alter a CHECK constraint in
-- place, so preserve the durable job state while replacing the constraint.
PRAGMA foreign_keys = OFF;

CREATE TABLE scan_jobs_next (
  scan_id TEXT PRIMARY KEY REFERENCES scan_sessions(id),
  stage TEXT NOT NULL CHECK (stage IN (
    'load-job', 'validate-source', 'normalize-document', 'build-chunks',
    'extract-chunks', 'merge-extractions', 'adjudicate', 'build-bundle',
    'build-report', 'finalize'
  )),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  reserved_units INTEGER NOT NULL CHECK (reserved_units >= 0),
  actual_units INTEGER,
  settlement_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO scan_jobs_next (
  scan_id, stage, attempt, reserved_units, actual_units, settlement_id,
  last_error_code, created_at, updated_at
)
SELECT scan_id, stage, attempt, reserved_units, actual_units,
       settlement_id, last_error_code, created_at, updated_at
FROM scan_jobs;

DROP TABLE scan_jobs;
ALTER TABLE scan_jobs_next RENAME TO scan_jobs;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_jobs_settlement_id
  ON scan_jobs(settlement_id);

PRAGMA foreign_keys = ON;
