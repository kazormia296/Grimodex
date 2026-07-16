CREATE TABLE scan_adjudication_results (
  scan_id TEXT NOT NULL REFERENCES scan_sessions(id),
  ambiguity_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scan_id, ambiguity_id)
);
