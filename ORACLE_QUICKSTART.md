# Oracle quickstart — Watchtower v2 (edge + latency)

## Solana whale (Helius)

```bash
SIGNALS_ENABLED=solana_whale
HELIUS_KEY=...
WHALE_SOL=500
MEGA_SOL=2000
PAID_LAG_MS=300000
TELEGRAM_PREMIUM_CHAT_ID=...   # or TG_PAID_CHANNEL
TELEGRAM_FREE_CHAT_ID=...      # or TG_CHANNEL
```

Paid TG + X fire immediately; free TG is delayed 5 minutes. See [docs/SOLANA_WHALE.md](./docs/SOLANA_WHALE.md).

## Deploy

```bash
ssh -i key ubuntu@IP
curl -fsSL https://raw.githubusercontent.com/StationaryDev37/watchtower-/main/deploy-oracle.sh | bash
cd ~/watchtower && nano .env
pm2 start watchtower.js --name watchtower
pm2 startup && pm2 save
```

## Verify edge path

```bash
curl -s http://127.0.0.1:3847/health | python3 -m json.tool
# expect architecture: single-source-v2
# expect priceFeed.live: true within ~5s
# expect signals.funding / liquidations present
```

`/health` returns **503** if price source and delivery are both down — wire your uptime check to that.

## Build order note

This tree is **PR #2 steps 1–3**: funding + liquidations, WSS prices + coalesce, watchdog + health + SQLite.  
Revenue funnel A/B, affiliate rotation, referrals, cex_flow/stables, conviction = later passes.
