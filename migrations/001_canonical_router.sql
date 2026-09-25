CREATE SCHEMA IF NOT EXISTS orin_router;
CREATE SCHEMA IF NOT EXISTS orin_platform;
CREATE TABLE IF NOT EXISTS orin_router.provider_pools (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
  wrapped_dek BYTEA NOT NULL, encrypted_dek BYTEA NOT NULL, iv BYTEA NOT NULL, auth_tag BYTEA NOT NULL,
  key_version TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orin_router.provider_catalog_snapshots (
  id BIGSERIAL PRIMARY KEY, provider TEXT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL,
  source_version TEXT NOT NULL, source_response_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('success','failure')), error_code TEXT
);
CREATE TABLE IF NOT EXISTS orin_router.catalog_models (
  snapshot_id BIGINT REFERENCES orin_router.provider_catalog_snapshots(id), model_id TEXT NOT NULL,
  capabilities JSONB NOT NULL, context_limit INTEGER NOT NULL, prompt_price NUMERIC, completion_price NUMERIC, image_price NUMERIC,
  PRIMARY KEY(snapshot_id, model_id)
);
CREATE TABLE IF NOT EXISTS orin_router.router_aliases (alias TEXT PRIMARY KEY CHECK (alias IN ('orin-cheap','orin-balanced','orin-thinking','orin-coding')), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS orin_router.router_chain_candidates (alias TEXT REFERENCES orin_router.router_aliases(alias), provider_pool_id TEXT REFERENCES orin_router.provider_pools(id), model_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(alias, provider_pool_id, model_id));
CREATE TABLE IF NOT EXISTS orin_router.provider_attempts (request_id TEXT NOT NULL, usage_reservation_id TEXT NOT NULL, account_id TEXT NOT NULL, alias TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 3), status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')), started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ, latency_ms INTEGER, units NUMERIC, estimated_cost_micros BIGINT, error_code TEXT, PRIMARY KEY(request_id, attempt_no));
CREATE TABLE IF NOT EXISTS orin_router.provider_key_incidents (provider_pool_id TEXT, reason TEXT NOT NULL, owner TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, released_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS orin_platform.outbox (event_id UUID PRIMARY KEY, schema_version TEXT NOT NULL, event_type TEXT NOT NULL, source TEXT NOT NULL, source_event_id TEXT NOT NULL, request_id TEXT, trace_id TEXT, correlation_id TEXT, account_id TEXT, session_id TEXT, run_id TEXT, outcome TEXT, duration_ms INTEGER, error_code TEXT, redacted_metadata JSONB NOT NULL, occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(), published_at TIMESTAMPTZ, UNIQUE(source, event_type, source_event_id));
