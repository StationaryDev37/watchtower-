/**
 * Config loader + boot-time schema validation.
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
  const coins = list('WATCH_COINS', ['bitcoin', 'ethereum', 'solana']).slice(
    0,
    num('MAX_COINS', 8)
  );
  const priceSymbols = list(
    'PRICE_SYMBOLS',
    coins.map(coinIdToUsdt)
  );

  const config = {
    brand: required('BRAND_NAME', 'Watchtower') || 'Watchtower',
    mode: required('WATCHTOWER_MODE', 'all') || 'all',
    logLevel: required('LOG_LEVEL', 'info') || 'info',
    pollIntervalSec: num('POLL_INTERVAL_SEC', 90),
    healthPort: num('HEALTH_PORT', 3847),
    publicBaseUrl,
    dryRun,
    strictConfig: bool('STRICT_CONFIG', !dryRun),
    memory: {
      maxCoins: num('MAX_COINS', 8),
      maxWatchAddresses: num('MAX_WATCH_ADDRESSES', 25),
    },
    alertCooldownSec: num('ALERT_COOLDOWN_SEC', 900),
    bus: {
      coalesceMs: num('ALERT_COALESCE_MS', 3000),
    },
    signalsEnabled: list('SIGNALS_ENABLED', ['market', 'funding', 'liquidations']),
    coins,
    thresholds: {
      priceMovePct: num('PRICE_MOVE_PCT', 2.5),
      volumeSpikePct: num('VOLUME_SPIKE_PCT', 40),
      whaleMinAmount: num('WHALE_MIN_AMOUNT', 1000),
    },
    price: {
      symbols: priceSymbols,
      binanceEnabled: bool('PRICE_BINANCE', true),
      bybitEnabled: bool('PRICE_BYBIT', true),
      fallbackPollSec: num('PRICE_FALLBACK_POLL_SEC', 120),
      marketEvalSec: num('MARKET_EVAL_SEC', 2),
    },
    funding: {
      symbols: list('FUNDING_SYMBOLS', priceSymbols.slice(0, 5)),
      pollSec: num('FUNDING_POLL_SEC', 60),
      zScore: num('FUNDING_ZSCORE', 2),
      flipAbs: num('FUNDING_FLIP_ABS', 0.0001),
    },
    liquidations: {
      symbols: list('LIQ_SYMBOLS', priceSymbols.slice(0, 5)),
      binanceEnabled: bool('LIQ_BINANCE', true),
      bybitEnabled: bool('LIQ_BYBIT', true),
      windowSec: num('LIQ_WINDOW_SEC', 60),
      thresholdUsd: num('LIQ_THRESHOLD_USD', 2_000_000),
    },
    helius: {
      apiKey: required('HELIUS_KEY') || required('HELIUS_API_KEY'),
      whaleSol: num('WHALE_SOL', 500),
      megaSol: num('MEGA_SOL', 2000),
      freeLagMs: num('PAID_LAG_MS', 5 * 60 * 1000),
      freeFlushSec: num('SOL_FREE_FLUSH_SEC', 30),
      digestMs: num('SOL_DIGEST_MS', 24 * 60 * 60 * 1000),
      maxInflight: num('HELIUS_MAX_INFLIGHT', 4),
    },
    store: {
      path: required('SQLITE_PATH', `${process.env.HOME || '/tmp'}/watchtower/watchtower.db`),
    },
    watchdog: {
      rssCeilingMb: num('RSS_CEILING_MB', 750),
      intervalSec: num('WATCHDOG_INTERVAL_SEC', 15),
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
      botToken:
        required('TELEGRAM_BOT_TOKEN') || required('TG_BOT_TOKEN'),
      freeChatId:
        required('TELEGRAM_FREE_CHAT_ID') ||
        required('TELEGRAM_CHAT_ID') ||
        required('TG_CHANNEL'),
      premiumChatId:
        required('TELEGRAM_PREMIUM_CHAT_ID') || required('TG_PAID_CHANNEL'),
      opsChatId: required('TELEGRAM_OPS_CHAT_ID'),
      inviteLink: required('TELEGRAM_PREMIUM_INVITE_LINK'),
      minIntervalMs: num('TELEGRAM_MIN_INTERVAL_MS', 40),
    },
    twitter: {
      apiKey: required('TWITTER_API_KEY') || required('X_API_KEY'),
      apiSecret: required('TWITTER_API_SECRET') || required('X_API_SECRET'),
      accessToken: required('TWITTER_ACCESS_TOKEN') || required('X_ACCESS_TOKEN'),
      accessSecret: required('TWITTER_ACCESS_SECRET') || required('X_ACCESS_SECRET'),
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
      productName: required('STRIPE_PRODUCT_NAME', 'Watchtower Premium Data Alerts'),
      monthlyUsd: num('PREMIUM_PRICE_USD', 29),
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

function coinIdToUsdt(id) {
  const map = {
    bitcoin: 'BTCUSDT',
    ethereum: 'ETHUSDT',
    solana: 'SOLUSDT',
    binancecoin: 'BNBUSDT',
    ripple: 'XRPUSDT',
    dogecoin: 'DOGEUSDT',
    cardano: 'ADAUSDT',
    'avalanche-2': 'AVAXUSDT',
  };
  return map[id] || `${String(id).slice(0, 4).toUpperCase()}USDT`;
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config.publicBaseUrl) errors.push('PUBLIC_BASE_URL is required');

  if (config.signalsEnabled.includes('solana_whale') && !config.helius.apiKey) {
    errors.push('SIGNALS_ENABLED includes solana_whale but HELIUS_KEY is missing');
  }

  if (config.signalsEnabled.includes('whale')) {
    if (!config.eth.rpcUrl) {
      errors.push('SIGNALS_ENABLED includes whale but ETH_RPC_URL is missing');
    }
    if (!config.eth.watchAddresses.length) {
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
    errors.push('No delivery channel configured');
  }

  const hasStripe = Boolean(config.stripe.secretKey);
  const hasCrypto =
    Boolean(config.cryptoRail.apiKey) ||
    Boolean(config.cryptoRail.payUrl) ||
    Boolean(config.cryptoRail.walletAddress);

  if (!config.dryRun && !hasStripe && !hasCrypto) {
    warnings.push('No payment rail configured — /checkout will 503 until set');
  }

  if (hasStripe && !config.telegram.inviteLink) {
    warnings.push('STRIPE configured but TELEGRAM_PREMIUM_INVITE_LINK missing');
  }

  if (!config.price.binanceEnabled && !config.price.bybitEnabled) {
    warnings.push('Both PRICE_BINANCE and PRICE_BYBIT disabled — relying on CoinGecko fallback only');
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

module.exports = { loadConfig, validateConfig, coinIdToUsdt };
