# Solana whale (Unchained model)

Drop-in `solana_whale` signal — same product shape as the standalone `unchained-watchtower` script, inside the Watchtower framework.

## Env

```bash
SIGNALS_ENABLED=solana_whale   # or comma-list with market,funding,...
HELIUS_KEY=...
WHALE_SOL=500
MEGA_SOL=2000
PAID_LAG_MS=300000             # free TG delay

TELEGRAM_BOT_TOKEN=...         # or TG_BOT_TOKEN
TELEGRAM_FREE_CHAT_ID=...      # or TG_CHANNEL
TELEGRAM_PREMIUM_CHAT_ID=...   # or TG_PAID_CHANNEL

TWITTER_API_KEY=...            # or X_API_KEY / X_API_SECRET / ...
```

## Delivery

| Channel | Timing |
|---|---|
| Premium Telegram | Immediate (`premium-only`) |
| X / Twitter | Immediate |
| Free Telegram | After `PAID_LAG_MS` (default 5 min), tagged delayed |
| Daily digest | Top wallets by whale-swap hits (24h) → free + all public channels |

## Why not a separate Railway ESM app?

One process on Oracle already has SQLite WAL, channel queues, Stripe, and `/health`. This signal reuses them — no second deploy, no duplicate DB.
