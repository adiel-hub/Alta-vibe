#!/usr/bin/env bash
# Bootstrap a clean local dev environment, then start `next dev`.
#
# What this does:
#   1. Installs dependencies if `node_modules` is missing.
#   2. Pulls every Vercel env var into `.env.local` (Mongo URI, Anthropic key,
#      ElevenLabs key, Firecrawl key, shared secret, …).
#   3. Forces USE_RAILWAY_WORKER='' so turns run via Next's `after()`
#      in-process — the worker path needs Railway and a redeploy each change.
#   4. Suggests setting MONGODB_DB=alta_vibe_dev so local agents don't pollute
#      prod data. Won't auto-set it; print the hint so you can opt in.
#   5. Hands off to `next dev`.

set -euo pipefail

cd "$(dirname "$0")/.."

# ── 1. dependencies ───────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "▸ installing dependencies (first run)…"
  npm install
fi

# ── 2. env pull ───────────────────────────────────────────────────────────
if ! command -v vercel >/dev/null 2>&1; then
  echo "✗ vercel CLI not found. Install it: npm i -g vercel@latest" >&2
  exit 1
fi

if [ ! -f .vercel/project.json ]; then
  echo "✗ this directory isn't linked to a Vercel project." >&2
  echo "  Run: vercel link --project alta-vibe --scope alta-ai --yes" >&2
  exit 1
fi

echo "▸ pulling env vars from Vercel (alta-ai/alta-vibe)…"
vercel env pull .env.local --environment=development --yes >/dev/null

# ── 3. local-only overrides ───────────────────────────────────────────────
# Strip any existing USE_RAILWAY_WORKER line and re-add an empty one. Idempotent.
if [ -f .env.local ]; then
  grep -v '^USE_RAILWAY_WORKER=' .env.local > .env.local.tmp || true
  mv .env.local.tmp .env.local
fi
echo "USE_RAILWAY_WORKER=" >> .env.local
echo "▸ USE_RAILWAY_WORKER cleared (turns will run via next/after locally)"

# ── 4. data-isolation hint ────────────────────────────────────────────────
if ! grep -q '^MONGODB_DB=' .env.local || grep -q '^MONGODB_DB=alta_vibe$' .env.local; then
  echo ""
  echo "  ⓘ  Heads up: you're pointed at the production database (alta_vibe)."
  echo "     Want isolation? Edit .env.local and set:"
  echo "         MONGODB_DB=alta_vibe_dev"
  echo "     Same Railway cluster, different namespace."
  echo ""
fi

# ── 5. dev server ─────────────────────────────────────────────────────────
echo "▸ starting next dev on http://localhost:3000"
exec npm run dev
