# Watchtower on Oracle Cloud — 15-minute launch

Single process on Always Free (target **1 OCPU / 1 GB**): signals → Telegram/X/Discord → Stripe (crypto fallback).

## Reality (read once)

| Risk | What we ship |
|---|---|
| Commodity signals churn premiums | Plugin surface; v1 = market + filtered whale; edges = drop-in files |
| Stripe restricts “signal” businesses | Data/entertainment framing + disclaimers; `/checkout/crypto` fallback rail |
| X spam kills acquisition | Template layer + `TWEET_STYLE`; tune cadence after first deploy |

Revenue math stays boring: **subs × price − $0 infra − Stripe/crypto fees**.

## Deploy

```bash
ssh -i your_ssh_key ubuntu@YOUR_PUBLIC_IP
curl -fsSL https://raw.githubusercontent.com/StationaryDev37/watchtower-/main/deploy-oracle.sh | bash
cd ~/watchtower
nano .env
pm2 start watchtower.js --name watchtower
pm2 startup && pm2 save
```

Open VCN ingress for **22** and **3847**.

## Minimum `.env`

```bash
PUBLIC_BASE_URL=http://YOUR_PUBLIC_IP:3847
SIGNALS_ENABLED=market
TELEGRAM_BOT_TOKEN=...
TELEGRAM_FREE_CHAT_ID=...
TELEGRAM_PREMIUM_CHAT_ID=...
TELEGRAM_PREMIUM_INVITE_LINK=...
STRIPE_SECRET_KEY=sk_test_...   # or live
PREMIUM_PRICE_USD=29
# Optional fallback:
# CRYPTO_RAIL=nowpayments
# CRYPTO_RAIL_API_KEY=...
```

Enable whale only with **both** `ETH_RPC_URL` and a capped `WATCH_ADDRESSES` list (unfiltered Transfer subs are refused).

## Verify

```bash
pm2 logs watchtower
curl http://127.0.0.1:3847/health
curl http://YOUR_IP:3847/
curl -I http://YOUR_IP:3847/checkout
```

Stripe webhook: `POST /webhook/stripe` (`checkout.session.completed`).  
Crypto IPN: `POST /webhook/crypto`.

## Add an edge signal

1. Copy `src/signals/_example.funding.js` → `src/signals/funding.js`
2. Implement fetch + `this.emit({ tier, title, body, ... })`
3. `SIGNALS_ENABLED=market,funding` and restart PM2
