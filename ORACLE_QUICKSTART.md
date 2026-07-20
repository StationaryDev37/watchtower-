# Watchtower on Oracle Cloud — 15-minute launch

Single-source framework: **signals → channels → Stripe** in one Node process.
No separate frontend, no second microservice, no 2–3 month build.

| Old timeline | Framework timeline |
|---|---|
| Month 1–2: build stack | **Hour 1:** deploy + keys |
| Month 2–3: monetize | **Day 1:** free alerts + `/checkout` live |
| Split apps / rewrites | **One repo, one PM2 process** |

---

## 0) Oracle Always Free VM (once)

1. Create an **Always Free** Ampere A1 or VM.Standard.E2.1.Micro instance (Ubuntu 22.04).
2. Open ingress **TCP 22** and **TCP 3847** in the VCN security list.
3. Note the public IP.

## 1) Deploy (3 commands)

```bash
# SSH
ssh -i your_ssh_key ubuntu@YOUR_PUBLIC_IP

# Bootstrap Node + PM2 + Watchtower
curl -fsSL https://raw.githubusercontent.com/StationaryDev37/watchtower-/main/deploy-oracle.sh | bash

# Configure + start
cd ~/watchtower
nano .env
pm2 start watchtower.js --name watchtower
pm2 startup && pm2 save
```

## 2) Minimum `.env` for day-1 revenue

```bash
PUBLIC_BASE_URL=http://YOUR_PUBLIC_IP:3847

TELEGRAM_BOT_TOKEN=...
TELEGRAM_FREE_CHAT_ID=...          # public growth channel
TELEGRAM_PREMIUM_CHAT_ID=...       # private paid channel
TELEGRAM_PREMIUM_INVITE_LINK=...   # shown after Stripe success

TWITTER_API_KEY=...
TWITTER_API_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_ACCESS_SECRET=...

STRIPE_SECRET_KEY=sk_live_...      # or sk_test_ for dry runs
PREMIUM_PRICE_USD=29

AFFILIATE_ENABLED=true
AFFILIATE_EXCHANGE_URL=https://... # referral link on every alert
```

Optional later: `ETH_RPC_URL` (whale premium wedge), `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, Discord webhook.

## 3) Verify

```bash
pm2 logs watchtower
curl http://127.0.0.1:3847/health
curl http://YOUR_PUBLIC_IP:3847/          # landing + CTA
curl -I http://YOUR_PUBLIC_IP:3847/checkout
```

## 4) Stripe webhook (same process)

In Stripe Dashboard → Developers → Webhooks:

- Endpoint: `http://YOUR_PUBLIC_IP:3847/webhook/stripe` (or your domain + TLS)
- Event: `checkout.session.completed`
- Paste signing secret into `STRIPE_WEBHOOK_SECRET`

Buyers hit `/checkout` → Stripe → `/success` + premium invite link.

## Architecture (why this is faster)

```
watchtower.js
 └─ Framework (one process)
     ├─ Signals   market · whale
     ├─ AlertBus  cooldown + fan-out
     ├─ Channels  Telegram (free+premium) · Twitter · Discord
     ├─ Revenue   Stripe Checkout · affiliates · upgrade CTAs
     └─ HTTP      /  /upgrade  /checkout  /webhook/stripe  /health
```

Add a channel or signal = one file under `src/channels` or `src/signals`.  
Monetization is not a phase-2 rewrite — it ships in the same binary.

## Go-live checklist (same day)

1. Post a sample free alert to Telegram + X.
2. Open `/checkout` in test mode; complete a $0 / test card payment.
3. Confirm premium invite on `/success`.
4. Turn on affiliate URL; confirm CTA appears on the next alert.
5. Flip Stripe to live keys when ready.

**Infra cost:** $0 on Oracle Always Free.  
**First dollar:** as soon as Stripe + premium invite are set — not month 2–3.
