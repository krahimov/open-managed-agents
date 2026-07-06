#!/usr/bin/env bash
# Dev stack with the Clerk simulator: JWKS server + main-node (API +
# built console on one origin). Pair with `node scripts/clerk-sim.mjs
# demo` to exercise billing. See docs/clerk-integration.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# JWKS server (idempotent — skip if already listening).
if ! curl -sf "http://127.0.0.1:${CLERK_SIM_PORT:-9377}/.well-known/jwks.json" >/dev/null 2>&1; then
  node scripts/clerk-sim.mjs serve &
  sleep 1
fi

# Simulator-issued issuer + webhook secret.
eval "$(node scripts/clerk-sim.mjs env | sed 's/^/export /')"

# Local stack: fresh SQLite (NEVER the shared Neon DATABASE_URL),
# real auth so both better-auth (console login) and Clerk Bearer work.
export DATABASE_URL=""
export DATABASE_PATH="${DATABASE_PATH:-./data/dev-clerk.db}"
export AUTH_DATABASE_PATH="${AUTH_DATABASE_PATH:-./data/dev-clerk-auth.db}"
export AUTH_DISABLED=0
export BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-dev-clerk-sim-secret}"
export PLATFORM_ROOT_SECRET="${PLATFORM_ROOT_SECRET:-dev-clerk-sim-root}"
export SANDBOX_PROVIDER="${SANDBOX_PROVIDER:-subprocess}"
export CLERK_FREE_PLAN_ACTIVE_SESSION_LIMIT="${CLERK_FREE_PLAN_ACTIVE_SESSION_LIMIT:-3}"
export CONSOLE_DIR="$(pwd)/apps/console/dist"
export PORT="${PORT:-8787}"

exec npx tsx apps/main-node/src/index.ts
