# Watchtower

Single-process **signals → delivery → subscription billing** framework for Oracle Always Free (1 OCPU / 1 GB).

Same shape as Alertatron / LunarCrush / paid TG channels: public market data in, Telegram/X/Discord out, premium gated by Stripe (crypto fallback). Revenue = subscribers × price − infra − fees — not magic.

## Reality checks (built into this repo)

1. **Signal quality = retention.** `market` + `whale` are commodity adapters so the framework boots. Paid edges drop in as files under `src/signals/` (see `_example.funding.js`) without touching core.
2. **Stripe freezes signal-adjacent merchants.** Framing is market-data / entertainment + disclaimers on every surface. `PAYMENT_FALLBACK=crypto` (NOWPayments / BTCPay / Solana Pay seam) so a freeze doesn’t nuke checkout.
3. **X posts need taste, not spam.** Template layer (`src/templates/alerts.js`, `TWEET_STYLE`) — growth cadence is tuned after deploy, not hardcoded.

## Architecture

```
watchtower.js
 └─ WatchtowerFramework
     ├─ signals/   (drop-in plugins)
     ├─ bus        (cooldown + fan-out)
     ├─ channels/  (telegram · twitter · discord)
     ├─ revenue/   (Stripe rail + crypto rail + affiliates)
     └─ http       :3847  /  /checkout  /checkout/crypto  /webhook/*  /health
```

## Deploy (Oracle)

```bash
ssh -i key ubuntu@IP
curl -fsSL https://raw.githubusercontent.com/StationaryDev37/watchtower-/main/deploy-oracle.sh | bash
cd ~/watchtower && nano .env
pm2 start watchtower.js --name watchtower && pm2 startup && pm2 save
```

Details: [ORACLE_QUICKSTART.md](./ORACLE_QUICKSTART.md)

## Local

```bash
cp .env.example .env
npm install
DRY_RUN=true npm start
```

Boot fails loud on load-bearing gaps when `STRICT_CONFIG=true` (default unless `DRY_RUN`).

## License

MIT
