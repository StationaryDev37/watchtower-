# Watchtower

**Single-source crypto alert framework** — market + whale signals, Telegram / X / Discord, and Stripe premium in **one Node process**. Built for Oracle Cloud Always Free ($0 infra).

Revenue is not a month 2–3 project. Free alerts, `/checkout`, affiliate CTAs, and premium Telegram share the same codebase from minute one.

## Why this is fast

| Approach | Timeline |
|---|---|
| Separate bot + site + billing stack | Months of glue |
| **Watchtower Framework** | Deploy in ~15 minutes, charge the same day |

```
signals → AlertBus → channels + revenue enrichers → Telegram / X / Discord
                              ↓
                     HTTP: /checkout · /webhook/stripe
```

## Deploy on Oracle (3 commands)

```bash
ssh -i your_ssh_key ubuntu@YOUR_PUBLIC_IP
curl -fsSL https://raw.githubusercontent.com/StationaryDev37/watchtower-/main/deploy-oracle.sh | bash
cd ~/watchtower && nano .env && pm2 start watchtower.js --name watchtower && pm2 startup && pm2 save
```

Full walkthrough: **[ORACLE_QUICKSTART.md](./ORACLE_QUICKSTART.md)**

## Local

```bash
cp .env.example .env
npm install
DRY_RUN=true npm start
```

## Day-1 monetization paths

1. **Stripe Premium** — `GET /checkout` creates a Checkout Session; success page surfaces `TELEGRAM_PREMIUM_INVITE_LINK`.
2. **Affiliate CTAs** — every alert can append `AFFILIATE_EXCHANGE_URL`.
3. **Free → paid funnel** — public Telegram/X for growth; whale / strong moves hit the premium channel.

## Layout

```
watchtower.js           # entry
deploy-oracle.sh        # Oracle bootstrap
watchtower-package.json # dependency mirror
src/
  framework.js          # orchestrator
  bus.js                # in-process alert spine
  config.js
  channels/             # telegram · twitter · discord
  signals/              # market · whale
  revenue/              # Stripe + affiliates
  http/                 # landing · checkout · webhook · health
```

## License

MIT
