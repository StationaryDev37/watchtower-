# Oracle quickstart — Watchtower v2 (edge + latency)

## SIGNALS_ENABLED (recommended)

```bash
SIGNALS_ENABLED=market,funding,liquidations
PRICE_BINANCE=true
PRICE_BYBIT=true
ALERT_COALESCE_MS=3000
RSS_CEILING_MB=750
SQLITE_PATH=$HOME/watchtower/data/watchtower.db
```

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
