# Orin Router

One OpenAI-compatible API over many providers. Priority routing, failover,
API keys, streaming, logs. Part of the [Orin AI ecosystem](https://orinai.org).

```
APPLICATION
    │  base_url=https://router.orinai.org/v1  ·  api_key=orin_…
    ▼
ORIN ROUTER  (this repo — 7 serverless functions, 1 dependency)
    │  orin-smart → [openrouter/X → groq/Y → custom/Z]
    ▼
PROVIDER A → PROVIDER B → PROVIDER C …
```

Live: `https://router.orinai.org` · MIT licensed.

## Features

- **OpenAI-compatible**: `GET /v1/models`, `POST /v1/chat/completions`
  (JSON + SSE streaming). Drop into any OpenAI SDK:
  ```python
  from openai import OpenAI
  client = OpenAI(base_url="https://router.orinai.org/v1", api_key="orin_…")
  client.chat.completions.create(model="orin-smart",
      messages=[{"role": "user", "content": "Hello"}])
  ```
- **Routes, not models**: aliases (`orin-smart`) map to ordered
  provider/model hops. Priority order, failover on 429/5xx/timeout,
  credential-death skips the whole provider, model-level 400/404 hops on.
- **Health-aware**: per-hop cooldowns + latency EMAs. No fake health —
  health is observed outcomes only.
- **API keys**: `orin_`-prefixed, sha256-hashed, shown once, revokable,
  per-key per-minute limits.
- **Observability**: every request logged (request ID, route, provider,
  latency, status, error). `/admin/logs`, `/admin/stats`.
- **Security**: admin secret gate, AES-GCM provider credentials, SSRF guard
  on custom URLs, constant-time key compare, no secret ever logged.

## Architecture

```
src/
  types.ts       domain types (single source of truth)
  errors.ts      OrinError taxonomy + upstream classification
  providers.ts   adapter interface + openrouter/groq/custom (no routing here)
  router.ts      priority/failover/cooldowns/EMA (no provider code here)
  keys.ts        mint/hash/verify (timing-safe)
  ratelimit.ts   fixed-window limiter
  validate.ts    SSRF guard + request validation
  service.ts     orchestration (auth→validate→route→respond→log)
  store.ts       Neon persistence (the only dependency lives here)
  config.ts      env + first-boot seed
api/
  v1/chat/completions.ts   POST (stream optional) — thin HTTP skin
  v1/models.ts             GET (public)
  admin/providers.ts       GET/POST/DELETE
  admin/routes.ts          GET/POST/DELETE (validates provider refs)
  admin/keys.ts            GET (prefixes only)/POST (once)/DELETE=revoke
  admin/logs.ts            GET with filters
  admin/stats.ts           GET aggregates
test/  node:test, mocked fetch/store — 39 tests, no network, no database.
```

Dependency direction: `api → service → {router, providers, keys, store}`,
`router → providers(interface)`. UI-free. No cycles.

## Getting Started

```bash
git clone https://github.com/januththedev/orin-router-service
cd orin-router-service
npm install
npm test            # 39 tests, mocked — no keys, no database
```

## Configuration

Copy `.env.example` → Vercel env vars (never commit real values):

| Variable | Required | What |
|---|---|---|
| `DATABASE_URL` | Yes | Neon pooled connection string. Run `schema.sql` once. |
| `ORIN_ROUTER_ADMIN` | Yes | Bearer for `/admin/*` (`X-Admin-Secret`). 32+ random hex. |
| `ROUTER_MASTER_KEY` | Yes | AES-GCM key for provider credentials (min 32 chars). Rotating it invalidates stored provider keys. |
| `ROUTER_SEED_JSON` | No | First-boot providers/routes (applied only when tables are empty). |
| `ROUTER_COOLDOWN_MS` | No | Hop cooldown after retryable failures (default 60000). |

## Deployment

1. Run `schema.sql` in the Neon SQL editor.
2. Vercel → Add New → Project → import repo → set env vars → Deploy.
3. Seed (or use `/admin/*`):
   ```bash
   curl -X POST https://router.orinai.org/admin/providers \
     -H "X-Admin-Secret: $ADMIN" -H 'Content-Type: application/json' \
     -d '{"id":"or1","type":"openrouter","apiKey":"sk-or-…"}'
   curl -X POST https://router.orinai.org/admin/routes \
     -H "X-Admin-Secret: $ADMIN" -H 'Content-Type: application/json' \
     -d '{"id":"orin-smart","hops":[{"provider":"or1","model":"x-ai/grok-4-1-fast"}]}'
   curl -X POST https://router.orinai.org/admin/keys \
     -H "X-Admin-Secret: $ADMIN" -H 'Content-Type: application/json' \
     -d '{"name":"Production"}'   # → { "key": "orin_… (ONCE)" }
   ```

## API

- `GET /v1/models` — public. Route aliases as models.
- `POST /v1/chat/completions` — `Authorization: Bearer orin_…`. Body:
  `{model, messages, stream?, temperature?, max_tokens?}`. Errors are
  OpenAI-shaped `{error:{message,type,code}}`.
- Streaming: same endpoint with `"stream": true` → SSE `data:` deltas +
  `data: [DONE]`. Mid-stream provider death arrives as an SSE error payload
  (partial content already sent cannot be recalled — documented, tested).
- `GET/POST/DELETE /admin/providers|routes|keys`, `GET /admin/logs`,
  `GET /admin/stats` — all need `X-Admin-Secret`.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict)
npm test            # node --test (39 tests, mocked)
```

Tests live in `test/` and cover: priority/fallback/dead-key/cooldown/EMA,
auth codes, validation-first ordering, OpenAI response shapes, SSE framing,
mid-stream failure, hop fallback in streams, adapter classification
(429/5xx/401/400/timeout/empty), SSRF blocks, key mint/verify/collisions,
10-way concurrency (no lost logs, unique request IDs), duplicate-key
rejection. No network. No database.

## Contributing

Fork → branch → PR against `main`. One concern per PR. New providers go in
`src/providers.ts` behind the adapter interface with mocked tests — never
in the routing core. No keys, no paid services, no telemetry.

## License

MIT — see [LICENSE](LICENSE).

## Security

Report abuse vectors privately via issues. Notes for reviewers: keys are
sha256 + timing-safe compare; provider secrets are AES-GCM; SSRF guard
blocks literal private IPs and internal names (DNS-rebinding hostnames are
a documented limitation — custom providers are admin-configured, never
user-supplied); rate limits are per-instance burst guards on serverless
(documented, not distributed); logs carry key prefixes, never secrets.
