/**
 * Config loader + boot-time schema validation.
 * Missing load-bearing keys fail loudly at start — not mid-alert.
 */

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
  const dryRun = bool('DRY_RUN', false);

  const config = {
    brand: required('BRAND_NAME', 'Watchtower') || 'Watchtower',
    mode: required('WATCHTOWER_MODE', 'all') || 'all',
    logLevel: required('LOG_LEVEL', 'info') || 'info',
    pollIntervalSec: num('POLL_INTERVAL_SEC', 90),
    healthPort: num('HEALTH_PORT', 3847),
    publicBaseUrl,
    dryRun,
    strictConfig: bool('STRICT_CONFIG', !dryRun),
    // 1 OCPU / 1 GB Oracle — keep caps honest
    memory: {
      maxCoins: num('MAX_COINS', 8),
      maxWatchAddresses: num('MAX_WATCH_ADDRESSES', 25),
    },
    alertCooldownSec: num('ALERT_COOLDOWN_SEC', 900),
    signalsEnabled: list('SIGNALS_ENABLED', ['market']),
    coins: list('WATCH_COINS', ['bitcoin', 'ethereum', 'solana']).slice(
      0,
      num('MAX_COINS', 8)
    ),
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
      watchAddresses: list('WATCH_ADDRESSES').slice(0, num('MAX_WATCH_ADDRESSES', 25)),
    },
    telegram: {
      botToken: required('TELEGRAM_BOT_TOKEN'),
      freeChatId: required('TELEGRAM_FREE_CHAT_ID') || required('TELEGRAM_CHAT_ID'),
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
    payments: {
      primary: (required('PAYMENT_PRIMARY', 'stripe') || 'stripe').toLowerCase(),
      fallback: (required('PAYMENT_FALLBACK', 'crypto') || 'crypto').toLowerCase(),
    },
    stripe: {
      secretKey: required('STRIPE_SECRET_KEY'),
      webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
      priceId: required('STRIPE_PRICE_ID'),
      successUrl: required('STRIPE_SUCCESS_URL', `${publicBaseUrl}/success`),
      cancelUrl: required('STRIPE_CANCEL_URL', `${publicBaseUrl}/`),
      productName: required('STRIPE_PRODUCT_NAME', 'Watchtower Premium Alerts'),
      monthlyUsd: num('PREMIUM_PRICE_USD', 29),
      /** Framing for Stripe risk — data/entertainment, not advice */
      statementDescriptor: required('STRIPE_STATEMENT_DESCRIPTOR', 'WATCHTOWER DATA'),
    },
    cryptoRail: {
      provider: (required('CRYPTO_RAIL', 'nowpayments') || 'nowpayments').toLowerCase(),
      apiKey: required('CRYPTO_RAIL_API_KEY'),
      ipnSecret: required('CRYPTO_RAIL_IPN_SECRET'),
      payUrl: required('CRYPTO_RAIL_PAY_URL'),
      walletAddress: required('CRYPTO_RAIL_WALLET'),
      currency: required('CRYPTO_RAIL_CURRENCY', 'USDT'),
    },
    affiliate: {
      enabled: bool('AFFILIATE_ENABLED', true),
      exchangeUrl: required('AFFILIATE_EXCHANGE_URL'),
      exchangeLabel: required('AFFILIATE_EXCHANGE_LABEL', 'Trade now'),
      ctaEveryN: num('AFFILIATE_CTA_EVERY_N', 1),
    },
    growth: {
      upgradeCta: required('UPGRADE_CTA', 'Premium whale feed → /upgrade'),
      tweetUpgradeUrl: required('TWEET_UPGRADE_URL'),
      tweetStyle: required('TWEET_STYLE', 'compact') || 'compact',
    },
    legal: {
      disclaimer:
        required(
          'LEGAL_DISCLAIMER',
          'Market data alerts for informational/entertainment purposes only. Not financial advice. Do your own research.'
        ) ||
        'Market data alerts for informational/entertainment purposes only. Not financial advice. Do your own research.',
      shortDisclaimer:
        required('LEGAL_DISCLAIMER_SHORT', 'Not financial advice. DYOR.') ||
        'Not financial advice. DYOR.',
    },
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.publicBaseUrl) {
    errors.push('PUBLIC_BASE_URL is required');
  }

  if (config.signalsEnabled.includes('whale')) {
    if (!config.eth.rpcUrl) {
      errors.push('SIGNALS_ENABLED includes whale but ETH_RPC_URL is missing');
    }
    if (!config.eth.watchAddresses.length) {
      // Unfiltered Transfer subscription will melt a 1 GB Oracle box
      errors.push(
        'SIGNALS_ENABLED includes whale but WATCH_ADDRESSES is empty — refusing unfiltered Transfer flood on 1 GB RAM'
      );
    }
  }

  const hasTelegram = Boolean(config.telegram.botToken && config.telegram.freeChatId);
  const hasTwitter = Boolean(
    config.twitter.apiKey &&
      config.twitter.apiSecret &&
      config.twitter.accessToken &&
      config.twitter.accessSecret
  );
  const hasDiscord = Boolean(config.discord.webhookUrl);

  if (!config.dryRun && !hasTelegram && !hasTwitter && !hasDiscord) {
    errors.push(
      'No delivery channel configured — set Telegram and/or Twitter and/or Discord credentials'
    );
  }

  const hasStripe = Boolean(config.stripe.secretKey);
  const hasCrypto =
    Boolean(config.cryptoRail.apiKey) ||
    Boolean(config.cryptoRail.payUrl) ||
    Boolean(config.cryptoRail.walletAddress);

  if (!config.dryRun && !hasStripe && !hasCrypto) {
    warnings.push(
      'No payment rail configured (STRIPE_SECRET_KEY or CRYPTO_RAIL_*) — /checkout will 503 until set'
    );
  }

  if (hasStripe && !config.telegram.inviteLink) {
    warnings.push(
      'STRIPE configured but TELEGRAM_PREMIUM_INVITE_LINK missing — buyers cannot join premium after pay'
    );
  }

  if (config.coins.length > config.memory.maxCoins) {
    warnings.push(`WATCH_COINS truncated to MAX_COINS=${config.memory.maxCoins} for memory budget`);
  }

  for (const w of warnings) {
    console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: `config: ${w}` }));
  }

  if (errors.length) {
    const body = errors.map((e) => `  - ${e}`).join('\n');
    if (config.strictConfig) {
      throw new Error(`Watchtower config validation failed:\n${body}`);
    }
    for (const e of errors) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: `config: ${e}` }));
    }
  }
}

module.exports = { loadConfig, validateConfig };
