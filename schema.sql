-- Orin Router schema (Neon Postgres). Run once in the Neon SQL editor.
-- Provider credentials are AES-GCM ciphertext (ROUTER_MASTER_KEY server-side).
-- API key secrets are NEVER stored — only sha256 hashes.

CREATE TABLE IF NOT EXISTS router_providers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('openrouter','groq','custom')),
  base_url TEXT NOT NULL DEFAULT '',
  api_key_enc TEXT NOT NULL,
  models JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS router_routes (
  id TEXT PRIMARY KEY,
  hops JSONB NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS router_keys (
  id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  per_min INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS router_keys_hash_idx ON router_keys (hash);

CREATE TABLE IF NOT EXISTS router_logs (
  request_id TEXT PRIMARY KEY,
  key_prefix TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'error',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  completion_chars INTEGER NOT NULL DEFAULT 0,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS router_logs_at_idx ON router_logs (at DESC);
CREATE INDEX IF NOT EXISTS router_logs_status_idx ON router_logs (status);
