CREATE TABLE IF NOT EXISTS orin_router.provider_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_revealed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  encrypted JSONB NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'core'
);
CREATE INDEX IF NOT EXISTS provider_keys_account_created_idx ON orin_router.provider_keys(account_id, created_at DESC);
ALTER TABLE orin_router.provider_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY provider_keys_account_access ON orin_router.provider_keys FOR ALL
  USING (account_id = current_setting('app.account_id', true))
  WITH CHECK (account_id = current_setting('app.account_id', true));
