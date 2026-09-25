# Orin Router Service

Canonical cloud inference gateway for Orin Core and future Orin clients.

## Public surface

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`

Every public request requires an Orin Core service assertion with `aud=orin-router`, `typ=service`, and `scope=router:invoke`. Billable requests also carry a Core usage reservation ID.

The public model vocabulary is exactly:

```text
orin-cheap
orin-balanced
orin-thinking
orin-coding
```

Raw provider model IDs, wildcards, BYOK routes, user gateway-key management, and public dashboards are deferred to a separately approved Router product release.

## Architecture

```text
Orin Core
  -> reserve canonical usage
  -> short-lived service assertion
  -> Router /v1
  -> fresh zero-price catalog candidates
  -> Upstash eligibility/cooldown/circuit state
  -> bounded provider attempt
  -> provider-attempt facts/outbox
  -> Core reconciliation
```

## Local verification

```bash
npm ci
npm run platform:build
npm run check
```

Tests are hermetic and use no live provider, database, Redis, or Vercel production service.

## Deployment

Vercel exposes exactly five functions:

1. `api/v1/chat/completions.ts`
2. `api/v1/images/generations.ts`
3. `api/v1/models.ts`
4. `api/internal/catalog/refresh.ts`
5. `api/internal/attempts/[requestId].ts`

Run migrations in order from `migrations/`. Production requires the secret-service values listed in `.env.example`; missing values fail startup. Catalog refresh is exposed as an authenticated internal route and must be called by an external scheduler at least every six hours; Vercel cron is intentionally not used because its frequency/plan limits are not part of the runtime contract. There is no in-memory rate, health, or usage fallback in live mode.

## Platform contract

This repository pins `platform-v1.0.0` in `vendor/orin-platform`. It does not duplicate platform aliases, errors, URL policy, or event contracts.

## License

MIT
