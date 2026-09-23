# Orin Router

Many APIs in, one API out. Add your OpenRouter, Groq and OpenAI-compatible
keys in the dashboard, get **one endpoint + one key** that fans out across
all of them with automatic failover. Part of the
[Orin AI ecosystem](https://orinai.org).

```
YOUR APP
    │  base_url=https://router.orinai.org/v1  ·  api_key=orin_…
    ▼
ORIN ROUTER  (this repo — 6 serverless functions, 1 dependency)
    │  per-user fanout: exact model match → wildcard providers → failover
    ▼
YOUR OpenRouter key → YOUR Groq key → YOUR custom endpoints …
```

Live: `https://router.orinai.org` · MIT licensed.

## How it works

1. **Sign in** with your Orin session token (or MCP credential) — every
   provider, key and log row belongs to your Orin uid.
2. **Add APIs**: provider id, type (`openrouter` | `groq` | `custom`),
   key, and the models it serves (blank = serves any model). Keys are
   AES-GCM encrypted in Neon, never returned by any endpoint.
3. **Mint one gateway key** (`orin_…`, shown once). Point any OpenAI client
   at `/v1` with it.
4. **Request a model** → candidates = your enabled providers serving it
   (exact match first, wildcards after, in the order added) → first
   success wins. 429/5xx/timeout cools that provider, dead credentials
   skip the whole provider, model-level 400/404 moves on immediately.

```python
from openai import OpenAI
client = OpenAI(base_url="https://router.orinai.org/v1", api_key="orin_…")
client.chat.completions.create(model="x-ai/grok-4-1-fast",
    messages=[{"role": "user", "content": "Hello"}])
```

## Features

- **OpenAI-compatible**: `GET /v1/models`, `POST /v1/chat/completions`
  (JSON + SSE streaming). Per-user models: the union of your configured models.
- **Health-aware**: per-provider cooldowns + latency EMAs. No fake health —
  health is observed outcomes only.
- **Gateway keys**: `orin_`-prefixed, sha256-hashed, shown once, revokable,
  per-key per-minute limits. One key serves one user's providers.
- **Dashboard** (`index.html`, no build): providers + live test, keys,
  usage, logs. Provider keys are never displayed after saving.
- **Observability**: every request logged (request ID, requested model,
  provider, latency, status, error). Test calls are logged too.
- **Security**: owner auth (Orin session/MCP, fail-closed), AES-GCM provider
  credentials, SSRF guard on custom URLs, constant-time key compare,
  no secret ever logged.

## Architecture

```
src/
  types.ts       domain types (single source of truth)
  errors.ts      OrinError taxonomy + upstream classification
  providers.ts   adapter interface + openrouter/groq/custom (no routing here)
  router.ts      priority/failover/cooldowns/EMA (provider-agnostic core)
  keys.ts        mint/hash/verify (timing-safe)
  auth.ts        Orin session/MCP verify → owner uid
  ratelimit.ts   fixed-window limiter
  validate.ts    SSRF guard + request validation
  service.ts     fanout orchestration + user management (no HTTP here)
  store.ts       Neon persistence, user-scoped (the only dependency lives here)
  config.ts      env (DATABASE_URL, ROUTER_MASTER_KEY, TOKEN_ENCRYPTION_KEY)
api/
  providers.ts   GET/POST(+test)/DELETE — owner auth
  keys.ts        GET/POST(mint once)/DELETE — owner auth
  logs.ts        GET — own traffic only
  stats.ts       GET — own aggregates only
  v1/chat/completions.ts   POST (stream optional) — gateway key auth
  v1/models.ts             GET — gateway key auth, own models
test/  node:test, mocked fetch/store — no network, no database.
```

Dependency direction: `api → service → {router, providers, keys, store}`,
`router → providers(interface)`. No cycles.

## Getting Started

```bash
git clone https://github.com/januththedev/orin-router-service
cd orin-router-service
npm install
npm test            # mocked — no keys, no database
```

## Configuration

Copy `.env.example` → Vercel env vars (never commit real values).
`TOKEN_ENCRYPTION_KEY` must equal the Orin core value. `DATABASE_URL` may be
the same Neon project as core (namespaced tables) — run `schema.sql` once.

| Variable | Required | What |
|---|---|---|
| `DATABASE_URL` | Yes | Neon pooled connection string. |
| `TOKEN_ENCRYPTION_KEY` | Yes | Same as Orin core (dashboard auth). Min 32 chars. |
| `ROUTER_MASTER_KEY` | Yes | AES-GCM key for provider credentials (min 32 chars). Rotating it invalidates stored provider keys. |
| `ROUTER_COOLDOWN_MS` | No | Hop cooldown after retryable failures (default 60000). |

## Development

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # node --test (mocked)
```

Tests cover: fanout priority/fallback/dead-key/cooldown/EMA, per-user
isolation (providers/keys/logs/models), add/test/mint validation, auth codes,
validation-first ordering, OpenAI response shapes, SSE framing, mid-stream
failure, adapter classification (429/5xx/401/400/timeout/empty), SSRF blocks,
key mint/verify/collisions, 10-way concurrency. No network. No database.

## Contributing

Fork → branch → PR against `main`. One concern per PR. New providers go in
`src/providers.ts` behind the adapter interface with mocked tests — never
in the routing core. No keys, no paid services, no telemetry.

## License

MIT — see [LICENSE](LICENSE).

## Security

Report abuse vectors privately via issues. Notes for reviewers: gateway keys
are sha256 + timing-safe compare; provider secrets are AES-GCM; SSRF guard
blocks literal private IPs and internal names (DNS-rebinding hostnames are a
documented limitation — custom providers are user-configured, so validate
URLs before saving); rate limits are per-instance burst guards on serverless
(documented, not distributed); logs carry key prefixes, never secrets.
