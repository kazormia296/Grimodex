ALTER TABLE upload_intents ADD COLUMN ai_consent_id TEXT;
ALTER TABLE upload_intents ADD COLUMN ai_consent_policy_version TEXT;
ALTER TABLE upload_intents ADD COLUMN ai_consent_provider TEXT;
ALTER TABLE upload_intents ADD COLUMN ai_consent_route TEXT
  CHECK (ai_consent_route IS NULL OR ai_consent_route = 'scan');

ALTER TABLE scan_sessions ADD COLUMN ai_consent_id TEXT;
ALTER TABLE scan_sessions ADD COLUMN ai_consent_policy_version TEXT;
ALTER TABLE scan_sessions ADD COLUMN ai_consent_provider TEXT;
ALTER TABLE scan_sessions ADD COLUMN ai_consent_route TEXT
  CHECK (ai_consent_route IS NULL OR ai_consent_route = 'scan');
