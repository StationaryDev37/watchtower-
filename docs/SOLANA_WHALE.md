# Solana whale (Unchained model) — first-class Watchtower signal

`solana_whale` uses Helius `logsSubscribe` on Raydium + Orca, scores each
swap through `SignalSession` (OBSERVED → SCORED → PUBLISHED → SETTLED), and
dispatches:

| Channel | Timing | Gate |
|---|---|---|
| Premium Telegram | Immediate | `score.total ≥ PUBLISH_THRESHOLD_PAID` (0.55) |
| X / Twitter | Immediate | same |
| Free Telegram | After `PAID_LAG_MS` (default 5m) | `score.total ≥ PUBLISH_THRESHOLD_FREE` (0.65) |
| Daily digest | 24h top wallets | always when data exists |

## Env (Railway / Oracle / `.env`)

```bash
SIGNALS_ENABLED=solana_whale
HELIUS_KEY=
WHALE_SOL=500
MEGA_SOL=2000
PAID_LAG_MS=300000

TG_BOT_TOKEN=                 # or TELEGRAM_BOT_TOKEN
TG_CHANNEL=@unchained_watchtower   # free
TG_PAID_CHANNEL=              # premium (required for paid lane)

X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_SECRET=
```

Aliases accepted: `TELEGRAM_*`, `TWITTER_*`, `HELIUS_API_KEY`.

## Score

```
total = 0.35·confidence + 0.30·magnitude + 0.20·novelty + 0.15·urgency
```

Free tier is stricter than paid — paid edge is **speed + depth**.

## Verify

```bash
npm test
# after deploy:
pm2 logs watchtower --lines 80 | grep -E "helius ws open|ALERT solana_whale"
```

If quiet on a normal Solana day, drop `WHALE_SOL=200` temporarily.

## Moat tables

`sessions`, `receipts`, `wallet_stats`, `outcomes`, `solana_events` — migration `0002_sessions.sql`.
Do not wipe these; they are the product dataset.
