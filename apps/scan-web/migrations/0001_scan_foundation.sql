PRAGMA foreign_keys = ON;

-- Source bytes never live in D1. Only immutable R2 keys, hashes and metadata do.
CREATE TABLE upload_intents (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size > 0),
  actual_size INTEGER,
  source_hash TEXT,
  source_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('issued', 'uploaded', 'consumed', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE scan_sessions (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES upload_intents(id),
  mode TEXT NOT NULL CHECK (mode IN ('quick', 'full')),
  status TEXT NOT NULL CHECK (status IN (
    'created', 'uploading', 'queued', 'validating', 'chunking', 'extracting',
    'merging', 'adjudicating', 'reporting', 'completed', 'cancel_requested',
    'cancelled', 'failed', 'expired', 'deleted'
  )),
  source_hash TEXT,
  private_bundle_key TEXT,
  private_report_key TEXT,
  cancel_requested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scan_jobs (
  scan_id TEXT PRIMARY KEY REFERENCES scan_sessions(id),
  stage TEXT NOT NULL CHECK (stage IN (
    'load-job', 'validate-source', 'normalize-document', 'build-chunks',
    'extract-chunks', 'merge-extractions', 'adjudicate', 'build-bundle', 'build-report', 'finalize'
  )),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  reserved_units INTEGER NOT NULL CHECK (reserved_units >= 0),
  actual_units INTEGER,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scan_chunks (
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  chunk_hash TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  input_key TEXT NOT NULL,
  extraction_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scan_id, chunk_hash, pipeline_version)
);

CREATE TABLE scan_artifacts (
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('bundle', 'private-report', 'public-report', 'source', 'chunk-input', 'chunk-extraction')),
  object_key TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scan_id, artifact_kind)
);

CREATE TABLE usage_buckets (
  bucket_key TEXT PRIMARY KEY,
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  actual_units INTEGER NOT NULL DEFAULT 0 CHECK (actual_units >= 0),
  limit_units INTEGER NOT NULL CHECK (limit_units >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_usage_ledger (
  operation_id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'failed', 'refunded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE editor_tokens (
  token_hash TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  artifact_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE finding_feedback (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  finding_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intentional', 'rejected')),
  created_at TEXT NOT NULL,
  UNIQUE (scan_id, finding_id)
);

CREATE TABLE public_reports (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  artifact_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'unpublished')),
  author_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_upload_intents_status_expiry ON upload_intents(status, expires_at);
CREATE INDEX idx_scan_sessions_status_updated ON scan_sessions(status, updated_at);
CREATE INDEX idx_scan_artifacts_expiry ON scan_artifacts(expires_at);
CREATE INDEX idx_editor_tokens_expiry ON editor_tokens(expires_at, consumed_at);
CREATE INDEX idx_public_reports_status ON public_reports(status);
CREATE UNIQUE INDEX idx_public_reports_scan ON public_reports(scan_id);
