#!/bin/bash
# One-time setup + deploy of the Plot Only server to your Cloudflare account (free plan is enough).
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is needed first: https://nodejs.org (LTS)"; exit 1; }

echo "1/4 Installing Cloudflare's tool (wrangler)…"
npm install --silent

echo "2/4 Signing in to Cloudflare (a browser window opens; create a free account if you don't have one)…"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

if grep -q REPLACE_WITH_KV_ID wrangler.toml; then
  echo "3/4 Creating the cache storage…"
  out=$(npx wrangler kv namespace create PLANS 2>&1); echo "$out"
  id=$(echo "$out" | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$id" ] || { echo "Couldn't read the storage id above. Paste it into wrangler.toml in place of REPLACE_WITH_KV_ID, then run this again."; exit 1; }
  sed -i '' "s/REPLACE_WITH_KV_ID/$id/" wrangler.toml
else
  echo "3/4 Cache storage already set up."
fi

echo "4/4 Deploying…"
npx wrangler deploy
echo
echo "Now paste your Anthropic API key when asked. It's stored encrypted in Cloudflare and never sent to users."
npx wrangler secret put ANTHROPIC_API_KEY
echo
echo "Done! Copy the https://plot-only-api.<something>.workers.dev address printed above,"
echo "then: Plot Only extension icon → Server URL → paste → Save."
