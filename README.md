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

## Upstream providers

The zero-price catalog is built from more than one source, and each entry keeps
the provider that actually serves it:

| Provider | Free marker | Shared platform key | Notes |
|---|---|---|---|
| `openrouter` | `:free` | yes | The platform key belongs here. |
| `opencode` | `-free` | **no** | BYOK only. See below. |
| `deepseek`, `groq`, `openai` | `:free` | no | BYOK only. |

The marker is read per provider rather than globally. OpenRouter writes
`:free` and OpenCode Zen writes `-free`, so one global suffix would either
reject every Zen model or accept a Zen id as an OpenRouter one and send it to
the wrong host. A marker alone never authorises a model: pinning still has to
match an entry in the catalog, so an invented `something-free` resolves to "no
eligible model" rather than reaching a provider. A free marker is a *pricing*
signal, not a reachability guarantee — the per-`provider:model` circuit breaker
(ejected after 3 failures, cleared by the first success) is what absorbs models
that are marked free but not currently serving.

### Why OpenCode is BYOK-only

OpenCode Zen's no-cost models are deliberately **not** reachable through a
shared Orin credential.

OpenCode's Terms of Use (<https://opencode.ai/legal/terms-of-service>, effective
2026-08-15) state:

> You will only use the Services for your own internal use, and not on behalf of
> or for the benefit of any third party, and only in a manner that complies with
> all laws that apply to you.

Routing its free tier for our own users is use on behalf of third parties, so a
shared key is prohibited by that sentence. Two measured facts agree, both taken
from the live API rather than the docs (2026-10-01, 11 free model ids):

- 6 of 11 answer `HTTP 403 FreeTierError: "OpenCode's free tier can only be
  used from within OpenCode"`, and 4 more return 500/400. Spoofing
  `x-opencode-client`, `x-opencode-session` and `User-Agent` does not defeat the
  gate. Only `space-bunny-free` answered `HTTP 200` with no credential.
- On an unpaid account OpenCode may use Content "to further develop and improve
  our Services", so relaying a user's prompts would feed a training pipeline the
  user never agreed to. Some free models additionally carry vendor trial terms
  (the Nemotron endpoints are explicitly "Trial use only — do not submit
  personal or confidential data").

Requiring the account's own key keeps the request the user's own internal use,
which is what the terms permit. OpenCode therefore appears in the catalog and is
reachable the moment an account stores its own `opencode` provider key; without
one, those candidates are skipped and routing fails over to OpenRouter.

Two env vars behave as before: `ORIN_ROUTER_CATALOG_SOURCE_URL` still narrows
the refresh to a single explicit source, and leaving it unset fans out to every
configured source.

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
