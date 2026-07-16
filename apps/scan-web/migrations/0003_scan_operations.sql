-- Content-free public abuse intake. The report body is never copied here.
CREATE TABLE IF NOT EXISTS public_report_abuse_reports (
  id TEXT PRIMARY KEY,
  public_report_id TEXT NOT NULL REFERENCES public_reports(id),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_public_report_abuse_created
  ON public_report_abuse_reports(created_at);

-- One short-lived bucket per report/IP/window bounds unauthenticated abuse intake
-- even when the optional edge Rate Limiter binding is not configured.
CREATE TABLE IF NOT EXISTS abuse_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_abuse_rate_limits_updated
  ON abuse_rate_limits(updated_at);
