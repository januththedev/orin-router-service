-- Orin Router schema (Neon Postgres). Run once in the Neon SQL editor.
-- Multi-tenant: every row belongs to a user_uid (Orin uid from session/MCP token).
-- Provider credentials are AES-GCM ciphertext (ROUTER_MASTER_KEY server-side).
-- Gateway key secrets are NEVER stored — only sha256 hashes.

CREATE TABLE IF NOT EXISTS router_providers (
  user_uid TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('openrouter','groq','custom')),
  base_url TEXT NOT NULL DEFAULT '',
  api_key_enc TEXT NOT NULL,
  models JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now())::BIGINT),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_uid, id)
);

CREATE TABLE IF NOT EXISTS router_keys (
  id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  per_min INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS router_keys_hash_idx ON router_keys (hash);
CREATE INDEX IF NOT EXISTS router_keys_user_idx ON router_keys (user_uid);

CREATE TABLE IF NOT EXISTS router_logs (
  request_id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL,
  key_prefix TEXT NOT NULL DEFAULT '',
  requested TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'error',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  completion_chars INTEGER NOT NULL DEFAULT 0,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS router_logs_user_at_idx ON router_logs (user_uid, at DESC);
CREATE INDEX IF NOT EXISTS router_logs_user_status_idx ON router_logs (user_uid, status);
