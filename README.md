# Orin Router Service

Canonical cloud inference gateway for Orin Core and future Orin clients.

## Public surface

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/images/generations`

Every public inference request accepts either an Orin Core service assertion (`aud=orin-router`, `typ=service`, `scope=router:invoke`) or a revocable `orin_...` gateway key created through the authenticated dashboard API. Core assertions also carry a usage reservation ID. Provider-key and management operations always require the stronger Core `router:manage` scope.

The public model vocabulary is exactly:

```text
orin-cheap
orin-balanced
orin-thinking
orin-coding
```

Raw provider model IDs and wildcards remain unavailable on the public inference
surface. The authenticated management API is available at
`POST /api/dashboard/keys` for Core service assertions carrying
`scope=router:manage`; it supports list, create/one-time-reveal, rotate, and
revoke actions. Provider secrets are envelope-encrypted with
`ORIN_PROVIDER_KEK_CURRENT` and are never returned by list operations.

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

Vercel exposes the inference surface plus the authenticated dashboard:

1. `api/v1/chat/completions.ts`
2. `api/v1/images/generations.ts`
3. `api/v1/models.ts`
4. `api/internal/catalog/refresh.ts`
5. `api/internal/attempts/[requestId].ts`
6. `api/dashboard/keys.ts`
7. `api/dashboard/overview.ts`

Run migrations in order from `migrations/`. Production requires the secret-service values listed in `.env.example`; missing values fail startup. Catalog refresh is exposed as an authenticated internal route and must be called by an external scheduler at least every six hours; Vercel cron is intentionally not used because its frequency/plan limits are not part of the runtime contract. There is no in-memory rate, health, or usage fallback in live mode.

## Platform contract

This repository pins `platform-v1.0.0` in `vendor/orin-platform`. It does not duplicate platform aliases, errors, URL policy, or event contracts.

## License

MIT
