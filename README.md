# Watchtower — PR #2 architectural pass

Single process on Oracle Always Free. **Math is in the code, not the brochure.**

## Architecture

```
signals → AlertBus (dedup/coalesce/lanes) → channels
    ↑                ↑
 sources/         ConvictionScorer
 (Price/Funding/Liq)     ↑
                      store/history (outcomes)
 ops/ Watchdog · CircuitBreaker · Health
```

| Layer | What |
|---|---|
| **PriceRouter** | Binance/Bybit WSS · MAD-z spike (`Z_FIRE=3.5`) · CoinGecko fallback |
| **FundingRouter** | Cross-venue `d_v` ≥ `D_FIRE` · sign flips |
| **LiquidationsFeed** | `L_t = L·e^{-Δ/τ} + n` cascade ≥ `$5M` |
| **AlertBus** | Dedup 3s · coalesce 5s · lanes 6:3:1 |
| **ConvictionScorer** | Logistic 1–5 stars · priors → trained at n≥200 |
| **Watchdog** | RSS soft/hard/fatal shed + PM2 reload |

## Deploy

```bash
npm install
cp .env.example .env && nano .env
npm test          # scripts/replay.js
pm2 start watchtower.js --name watchtower
```

## Commits

- **A** — store + PriceRouter + market rewire  
- **B** — funding/liquidations + AlertBus lanes  
- **C** — ops + conviction + replay harness  

MIT
