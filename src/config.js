function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') return null;
  return value;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function loadConfig() {
  const publicBaseUrl = required('PUBLIC_BASE_URL', 'http://127.0.0.1:3847');

  return {
    brand: required('BRAND_NAME', 'Watchtower') || 'Watchtower',
    mode: required('WATCHTOWER_MODE', 'all') || 'all',
    logLevel: required('LOG_LEVEL', 'info') || 'info',
    pollIntervalSec: num('POLL_INTERVAL_SEC', 60),
    healthPort: num('HEALTH_PORT', 3847),
    publicBaseUrl,
    dryRun: bool('DRY_RUN', false),
    alertCooldownSec: num('ALERT_COOLDOWN_SEC', 900),
    signalsEnabled: list('SIGNALS_ENABLED', ['market', 'whale']),
    coins: list('WATCH_COINS', [
      'bitcoin',
      'ethereum',
      'solana',
      'binancecoin',
      'ripple',
    ]),
    thresholds: {
      priceMovePct: num('PRICE_MOVE_PCT', 3),
      volumeSpikePct: num('VOLUME_SPIKE_PCT', 40),
      whaleMinAmount: num('WHALE_MIN_AMOUNT', 1000),
    },
    coingecko: {
      baseUrl: required('COINGECKO_BASE_URL', 'https://api.coingecko.com/api/v3'),
      apiKey: required('COINGECKO_API_KEY'),
    },
    eth: {
      rpcUrl: required('ETH_RPC_URL'),
      watchAddresses: list('WATCH_ADDRESSES'),
    },
    telegram: {
      botToken: required('TELEGRAM_BOT_TOKEN'),
      /** Free public channel / group (growth + proof) */
      freeChatId: required('TELEGRAM_FREE_CHAT_ID') || required('TELEGRAM_CHAT_ID'),
      /** Paid private channel (Stripe unlocks access instructions) */
      premiumChatId: required('TELEGRAM_PREMIUM_CHAT_ID'),
      inviteLink: required('TELEGRAM_PREMIUM_INVITE_LINK'),
    },
    twitter: {
      apiKey: required('TWITTER_API_KEY'),
      apiSecret: required('TWITTER_API_SECRET'),
      accessToken: required('TWITTER_ACCESS_TOKEN'),
      accessSecret: required('TWITTER_ACCESS_SECRET'),
    },
    discord: {
      webhookUrl: required('DISCORD_WEBHOOK_URL'),
    },
    stripe: {
      secretKey: required('STRIPE_SECRET_KEY'),
      webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
      priceId: required('STRIPE_PRICE_ID'),
      successUrl: required('STRIPE_SUCCESS_URL', `${publicBaseUrl}/success`),
      cancelUrl: required('STRIPE_CANCEL_URL', `${publicBaseUrl}/`),
      productName: required('STRIPE_PRODUCT_NAME', 'Watchtower Premium Alerts'),
      monthlyUsd: num('PREMIUM_PRICE_USD', 29),
    },
    affiliate: {
      enabled: bool('AFFILIATE_ENABLED', true),
      exchangeUrl: required('AFFILIATE_EXCHANGE_URL'),
      exchangeLabel: required('AFFILIATE_EXCHANGE_LABEL', 'Trade now'),
      ctaEveryN: num('AFFILIATE_CTA_EVERY_N', 1),
    },
    growth: {
      /** Soft paywall CTA appended to free-channel alerts */
      upgradeCta: required(
        'UPGRADE_CTA',
        '⚡ Get whale + faster alerts → /upgrade'
      ),
      tweetUpgradeUrl: required('TWEET_UPGRADE_URL'),
    },
  };
}

module.exports = { loadConfig };
