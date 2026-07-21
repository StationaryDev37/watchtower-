# Watchtower

v2 single-process **edge signals + fast delivery + subscription billing** for Oracle Always Free (1 OCPU / 1 GB).

## What retains (not what demos)

| Plugin | Edge |
|---|---|
| `solana_whale` | Helius Raydium/Orca swaps ≥ N SOL — paid TG + X immediate, free TG delayed 5m, daily wallet leaderboard |
| `funding` | Cross-venue perp funding z-score + sign flips (Binance/Bybit/OKX) |
| `liquidations` | Cascade detection on Binance/Bybit force-order streams |
| `market` | Binance/Bybit WSS prices (~200ms), CoinGecko fallback only |
| `whale` | Filtered ETH watched-address transfers (opt-in) |

Held for later: `cex_flow`, `stables`, `new_pool` (support burden), conviction scoring (needs history).

## Latency + robustness

- AlertBus **dedup/coalesce** (3s window)
- Telegram **priority queue** (premium jumps public)
- **RSS watchdog** drops noisiest plugin at 750 MB
- `/health` → **200** only when price + delivery are up; else **503**
- **SQLite WAL** alert history + funnel events
- Graceful shutdown drains coalesce + Telegram queues

## Deploy

```bash
curl -fsSL https://raw.githubusercontent.com/StationaryDev37/watchtower-/main/deploy-oracle.sh | bash
cd ~/watchtower && nano .env
pm2 start watchtower.js --name watchtower && pm2 startup && pm2 save
```

See [ORACLE_QUICKSTART.md](./ORACLE_QUICKSTART.md).

## License

MIT
