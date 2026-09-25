#!/usr/bin/env bash
# Local smoke test: compiles the Router, boots it in fake mode, and checks it serves.
# This is the same command the Docker image runs, exercised without Docker.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm run build >/dev/null

export DATABASE_URL=fake
export ORIN_ROUTER_SERVICE_SIGNING_KEY=x
export ORIN_ROUTER_SERVICE_KEY_ID=x
export ORIN_CORE_INTROSPECTION_URL=http://127.0.0.1
export ORIN_CORE_CLIENT_ID=x
export ORIN_CORE_CLIENT_SECRET=x
export UPSTASH_REDIS_REST_URL=fake
export UPSTASH_REDIS_REST_TOKEN=x
export ORIN_ROUTER_REDIS_HASH_KEY=x
export ORIN_PROVIDER_KEK_CURRENT="$(node -e "process.stdout.write(Buffer.alloc(32,7).toString('base64'))")"
export CRON_SECRET=x
export ORIN_PROVIDER_MODE=fake
export PORT="${PORT:-8099}"
export HOST=127.0.0.1

node dist/server/index.js &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 3

echo "--- health ---"
curl -fsS "http://127.0.0.1:${PORT}/health"
echo ""
echo "--- models (fake preview) ---"
curl -fsS "http://127.0.0.1:${PORT}/v1/models" -H "x-orin-preview-service: 1" -H "authorization: Bearer preview"
echo ""
echo "smoke ok"
