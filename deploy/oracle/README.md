# Running Orin Router on Oracle Cloud Always Free

This is the full path from a bare Oracle account to a working, TLS-terminated
Orin Router that `orinai.org` can point at. It assumes a fresh Ubuntu VM and
that you already have a Neon database, an Upstash Redis, and an Orin Core
service credential.

Every step is written so you can tell whether it worked before moving on.

---

## Before you start

You need:

- A credit or debit card (Oracle verifies the account and refunds the hold).
- A DNS zone for `orinai.org` where you can add `A` records. Cloudflare's free
  plan is fine; Cloudflare DNS is not required.
- The `orinai.org` repository checked out somewhere.

### What Always Free actually gives you

| Resource | Always Free allowance |
| --- | --- |
| Ampere A1 (`VM.Standard.A1.Flex`) | 4 OCPU + 24 GB RAM total, across all A1 instances |
| AMD micro (`VM.Standard.E2.1.Micro`) | 2 instances, 1/8 OCPU and 1 GB each |
| Block volume | 200 GB total |

Three things to confirm in your own console before you commit to a design,
because Oracle changes them and they are not visible from a quick search:

1. **Public IPv4 billing.** Oracle began charging for public IPv4 addresses.
   Check the current Always Free allowance for your tenancy before you depend on
   a public IP for DNS. If it is chargeable, use a Cloudflare Tunnel or a free
   tunnel instead of step 4, and skip straight to step 6.
2. **Idle compute reclamation.** Oracle has reclaimed idle Always Free compute
   instances in the past. Read the current policy in your tenancy's terms. If
   reclamation is a risk, the cheapest mitigation is an external uptime check
   plus a cron that touches the service (step 11 already does this).
3. **A1 capacity in your home region.** The home region is permanent and
   free-tier A1 capacity is genuinely scarce in some regions. If
   `VM.Standard.A1.Flex` is unavailable, pick a region that has it *before* you
   create anything else.

---

## Step 1 — Create the Oracle account

1. Go to <https://www.oracle.com/cloud/free/> and start the Always Free signup.
2. Choose your **home region** carefully. It cannot be changed later, and it
   determines where your compute lives and which A1 capacity you can reach.
3. Complete the identity and card verification.

Wait for the tenancy to finish provisioning before continuing.

## Step 2 — Create the VCN

Networking → Virtual Cloud Networks → **Start VCN Wizard**.

- CIDR `10.0.0.0/16`.
- **Create public subnet** — this is what gives the VM a route to the internet.
- DNS resolution: enabled.

The wizard also creates an internet gateway and a route table that sends `0.0.0.0/0`
to that gateway, which is what you want.

## Step 3 — Create the VM

Compute → Instances → **Create instance**.

- Name: `orin-router`.
- Image: **Ubuntu 22.04** or **Ubuntu 24.04** (Canonical), 50 GB boot volume.
- Shape: `VM.Standard.A1.Flex` with **4 OCPU** and **24 GB** memory.
  If it is unavailable in your region, fall back to two
  `VM.Standard.E2.1.Micro` instances and put a load balancer in front, or use
  the A1 shape in a region that has capacity.
- Networking: the VCN and public subnet from step 2.
- Add your SSH public key. If you do not have one:
  ```bash
  ssh-keygen -t ed25519 -C "orin-router"
  ```
- **Do not** enable a boot volume backup or assign additional block volumes you
  do not need; they consume the free block volume allowance.

Wait for the instance to reach **RUNNING**, then note the **Public IP address**
from the instance details page.

## Step 4 — Stable addressing (optional but recommended)

An ephemeral public IP changes when the instance is stopped and started. If
public IPv4 is free for your tenancy:

Networking → VCN → **Public IPs** → Create public IP, then assign it to the
instance. Record it as `ROUTER_IP`.

If public IPv4 is chargeable for you, do not create one. Use a Cloudflare Tunnel
instead and note that the hostname still comes from `ROUTER_HOST`; only step 6's
DNS record changes.

## Step 5 — First SSH

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@ROUTER_IP
```

If the connection hangs, the cause is almost always ingress rules, not SSH.

## Step 6 — Open the firewall

Oracle filters traffic twice. Both layers must allow the port.

**Host firewall (Oracle):** the instance's VNIC → Subnet → **Security List** →
Add Ingress Rules:

| Source CIDR | Protocol | Destination Port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | 22 |
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |
| `0.0.0.0/0` | UDP | 443 |

Leave egress at its default (allow all). The Router itself only makes outbound
calls to the pinned provider origins and to Orin Core, and that allowlist is
enforced in code, not by the firewall.

If you prefer to lock egress down too, allow `443` out to the internet and
`5432` to your Neon host, then tighten from there once you have confirmed the
service works.

## Step 7 — DNS

At your DNS provider for `orinai.org`, add:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `router` | `ROUTER_IP` |
| `CNAME` | `www` | `router.orinai.org` (optional) |

If you are using Cloudflare, leave the proxy **DNS-only** (grey cloud) for the
first certificate. Turn the orange cloud on after TLS is working, and re-test
streaming chat — proxied long-lived responses can behave differently.

Verify from anywhere:

```bash
dig +short router.orinai.org
```

It must return `ROUTER_IP` before you continue, because Caddy cannot get a
certificate for a name that does not resolve to this host.

## Step 8 — Bootstrap the host

Still in the SSH session:

```bash
sudo apt update && sudo apt install -y git
sudo -u ubuntu git clone https://github.com/januththedev/orin-router-service /home/ubuntu/orin-router
cd /home/ubuntu/orin-router/deploy/oracle
sudo bash bootstrap.sh
```

This installs Docker from Docker's official repository, turns on `ufw` with only
22/80/443 open, enables unattended security upgrades and fail2ban, and applies
a few sysctls suited to a long-lived streaming API.

Confirm the firewall took:

```bash
sudo ufw status verbose
```

## Step 9 — Configure the environment

```bash
cd /home/ubuntu/orin-router
cp deploy/oracle/router.env.example deploy/oracle/router.env
chmod 600 deploy/oracle/router.env
nano deploy/oracle/router.env
```

Generate the secrets it needs:

```bash
openssl rand -base64 32   # ORIN_PROVIDER_KEK_CURRENT
openssl rand -hex 32      # ORIN_ROUTER_SERVICE_SIGNING_KEY
openssl rand -hex 16      # ORIN_ROUTER_REDIS_HASH_KEY
openssl rand -hex 16      # CRON_SECRET
```

Fill in:

- `ROUTER_HOST` — `router.orinai.org` (no scheme, no trailing slash).
- `DATABASE_URL` — your Neon **pooled** connection string.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — from Upstash.
- `ORIN_ROUTER_REDIS_HASH_KEY` — from above.
- `ORIN_ROUTER_SERVICE_SIGNING_KEY`, `ORIN_ROUTER_SERVICE_KEY_ID`,
  `ORIN_CORE_CLIENT_ID`, `ORIN_CORE_CLIENT_SECRET` — the shared values you
  configured on both Core and the Router.
- `ORIN_PROVIDER_KEK_CURRENT` — from above. **If you change this later, every
  stored provider key becomes unreadable** unless you also supply the old value
  as `ORIN_PROVIDER_KEK_PREVIOUS`.

Start in `ORIN_PROVIDER_MODE=fake`. It exercises the whole request path with
local fixtures and makes no outbound calls, so you can prove the plumbing before
spending or leaking anything.

`ORIN_PROVIDER_API_KEY` can stay empty if every account brings its own key
through the dashboard. Router will then fail closed with a clear error rather
than quietly spending the platform's money.

## Step 10 — Apply the database migrations

Apply these in numeric order against the Neon database:

```
001_canonical_router.sql   schemas and core tables
002_router_indexes_rls.sql indexes and row-level security
003_seed_aliases.sql       the four Orin aliases
004_legacy_quarantine.sql  renames any legacy public.* tables out of the way
005_provider_keys.sql      the per-account BYOK keyring
006_gateway_keys.sql       orin_... gateway keys
```

Either paste them into the Neon SQL editor, or use `psql`:

```bash
for f in migrations/0*.sql; do
  echo "== $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

Connect as the table owner (Neon's default `neondb_owner`) so the owner bypass
applies to the row-level security policies in `002`. If you connect as a
non-owner role instead, set `app.account_id` on every request, because the
attempt and key policies are scoped on it.

## Step 11 — Start the service and verify

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f router
```

Locally, from the host:

```bash
curl -fsS http://127.0.0.1:8080/health
```

Over TLS, from anywhere:

```bash
curl -fsS https://router.orinai.org/health
```

Both should print JSON containing `"status":"ok"`. If the public one fails and
the local one works, it is DNS or the security list, not the app.

Then check the API itself, still in fake mode:

```bash
curl -fsS https://router.orinai.org/v1/models \
  -H "x-orin-preview-service: 1" -H "authorization: Bearer preview"
```

The preview header only works while `ORIN_PROVIDER_MODE=fake`. In live mode it
is ignored and you need a real Core assertion or an `orin_...` gateway key.

### Keep the free model catalog fresh

The catalog is a cache with a six-hour freshness window. Refresh it from cron:

```bash
crontab -e
```

```
17 * * * * curl -fsS -X POST https://router.orinai.org/api/internal/catalog/refresh \
  -H "x-orin-cron-secret: $CRON_SECRET" >/dev/null
```

This also serves as the periodic activity that keeps an idle Always Free
instance from being reclaimed, if your tenancy's policy requires it.

## Step 12 — Switch to live

Once fake mode is proven end to end:

1. Set `ORIN_PROVIDER_MODE=live`.
2. Restart: `docker compose up -d`.
3. Warm the catalog using the cron call above, then confirm the free tier is
   populated:
   ```bash
   curl -fsS https://router.orinai.org/v1/models -H "authorization: Bearer $GATEWAY_KEY"
   ```
   Every non-alias model id in that list must end in `:free`. That is the same
   rule the Router enforces internally, so if it ever does not, stop and
   investigate before sending traffic.

4. Optionally set `ORIN_PROVIDER_API_KEY` as the platform fallback.

### Optional: run it without Docker

If you would rather not run a container, note that the standalone server needs a
compile step: the sources use `.js` import specifiers that only resolve after
TypeScript emits them.

```bash
sudo -u orin -H bash -lc '
  cd /opt/orin/router/src &&
  npm ci &&
  npm --prefix vendor/orin-platform ci &&
  npm --prefix vendor/orin-platform run build &&
  npm run build &&
  npm prune --omit=dev'
```

```ini
# /etc/systemd/system/orin-router.service
[Unit]
Description=Orin Router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=orin
WorkingDirectory=/opt/orin/router/src
EnvironmentFile=/opt/orin/router/router.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now orin-router
sudo journalctl -u orin-router -f
```

---

## Rolling back

```bash
docker compose down          # stop, keep images
docker compose down -v       # stop and discard TLS state; Caddy re-issues
```

To return to the previous release:

```bash
cd /opt/orin/router/src
git checkout <previous-tag>
docker compose up -d --build
```

The database is not touched by a rollback. If you need to undo a migration,
take a Neon branch or a restore point first — migrations `004` onward are not
trivially reversible.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| SSH times out | Ingress 22 missing | Add the security list rule, not just a local `ufw` rule |
| `curl https://...` returns a Caddy error | DNS does not point here yet | `dig +short` must return this host before Caddy can get a certificate |
| `Router failed.` in the logs | An unhandled server error | `docker compose logs router`; the standalone server logs the real cause |
| `No upstream credential is available for this account` | No BYOK key and no `ORIN_PROVIDER_API_KEY` | Add a key through the dashboard, or set the platform key |
| `No eligible free model is currently available` | Catalog empty or stale | Run the catalog refresh from step 11 |
| Provider keys exist but routing still uses the platform key | Revoked/expired key, or provider not in the fixed origin list | Check `list` on the dashboard key API; only OpenRouter, DeepSeek, Groq and OpenAI are wired |
| Streaming responses arrive all at once | Proxy buffering | Confirm the Caddyfile `flush_interval -1` rule survived; if you enabled the Cloudflare orange cloud, test again with it off |

---

## After this: pointing the rest of Orin at it

With `router.orinai.org` answering, the other products become DNS records and
front ends over the same API:

| Host | Product | Talks to Router via |
| --- | --- | --- |
| `orinai.org` | Ecosystem hub | `GET /v1/models` and `/health`, server-side |
| `chat.orinai.org` | Orin Chat | `POST /v1/chat/completions` through the Core backend |
| `code.orinai.org` | Orin Code web | same |
| `agent.orinai.org` | Orin Agent | same |
| `console.orinai.org` | Orin Console | its own sandbox service, not the Router |
| `tools.orinai.org` | Orin Tools | its own search/sandbox service, not the Router |
| `automate.orinai.org` | Orin Automations | compiles locally, then calls the Router for each step |

The three logged-in products (Chat, Code, Agent) authenticate to Core and hold
an `orin_...` gateway key, so they are the only ones that need the Router to
authenticate them. Console, Tools, and Automations stay keyless.
