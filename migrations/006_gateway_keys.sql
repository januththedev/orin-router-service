CREATE TABLE IF NOT EXISTS orin_router.gateway_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gateway_keys_account_created_idx ON orin_router.gateway_keys(account_id, created_at DESC);
ALTER TABLE orin_router.gateway_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY gateway_keys_account_access ON orin_router.gateway_keys FOR ALL
  USING (account_id = current_setting('app.account_id', true))
  WITH CHECK (account_id = current_setting('app.account_id', true));
