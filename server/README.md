# Plot Only server

A tiny Cloudflare Worker that:
- holds your Anthropic API key (users never need one),
- analyzes each episode/film **once** and caches the plan for everyone,
- builds a **season story map** so setups that pay off in later episodes are kept.

## Deploy (about 5 minutes)

In Terminal:

```
cd ~/Downloads/plot-only-server
./setup.sh
```

It installs Cloudflare's tool, signs you in (free account is fine), creates the cache, deploys,
and asks for your Anthropic API key. Copy the `https://plot-only-api.….workers.dev` address it
prints into the extension popup → **Server URL** → **Save**.

## Costs (approximate, Sonnet 5.5)

- New episode plan: ~$0.05 (film ~$0.12). Cached afterwards: free for every viewer.
- Season story map: ~$0.03 per episode read + ~$0.07 for the season look → ~$0.35–0.75 per 10-episode season, once.
- Cloudflare: free plan covers hobby scale.
- Safety limits in `wrangler.toml`: `DAILY_NEW_LIMIT` (all users) and `PER_IP_DAILY_LIMIT` (per person) cap new Claude calls per day. Cache hits are unlimited.

## Endpoints

- `GET /v1/plan/:movieId?h=<transcript sha256>[&s=<seasonKey>]`
- `POST /v1/plan` – `{ movieId, hash, title, end, transcript, sheets[], seasonId?, seasonKey? }`
- `GET /v1/season/:seasonId`
- `POST /v1/season` – `{ seasonId, show, episodes:[{ movieId, seq, title, hash, transcript }] }`

The server re-hashes every transcript it receives, so a cached plan can't be overwritten
with one built from different dialogue.

## Known limits

- The first viewer of a new season waits ~1–2 minutes longer for the season-aware version
  (they get the normal plan immediately meanwhile).
- Season maps are first-come: whoever's browser uploads a season's dialogue first defines it.
