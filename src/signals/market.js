const { SignalPlugin } = require('./base');

/**
 * Market moves from PriceFeed (Binance/Bybit WSS primary).
 * Latency target: hundreds of ms vs CoinGecko's 30–60s poll ceiling.
 */
class MarketSignal extends SignalPlugin {
  constructor(config, log, bus, deps = {}) {
    super(config, log, bus);
    this.name = 'market';
    this.priceFeed = deps.priceFeed || null;
    this.timer = null;
    this.lastPrices = new Map();
    this.lastPollAt = null;
    this.pollCount = 0;
  }

  async start() {
    const every = this.config.price.marketEvalSec * 1000;
    this.timer = setInterval(() => {
      this.evaluateAll().catch((err) => this.log.error('Market eval failed', { error: err.message }));
    }, every);
    if (this.timer.unref) this.timer.unref();
    this.log.info('Market signal started (WSS-primary)', {
      evalSec: this.config.price.marketEvalSec,
      coins: this.config.coins,
    });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
  }

  status() {
    return {
      running: Boolean(this.timer),
      lastPollAt: this.lastPollAt,
      pollCount: this.pollCount,
      tracked: this.lastPrices.size,
      feedLive: this.priceFeed?.isLive?.() || false,
    };
  }

  async evaluateAll() {
    if (!this.priceFeed) return;
    this.lastPollAt = new Date().toISOString();
    this.pollCount += 1;
    for (const coinId of this.config.coins) {
      const symbol = coinIdToUsdt(coinId);
      const tick = this.priceFeed.get(symbol);
      if (!tick?.price) continue;
      await this.evaluate(coinId, symbol, tick);
    }
  }

  async evaluate(coinId, symbol, tick) {
    const price = tick.price;
    const prev = this.lastPrices.get(symbol);
    this.lastPrices.set(symbol, price);
    if (prev == null) return;

    const movePct = ((price - prev) / prev) * 100;
    const absMove = Math.abs(movePct);
    const change1h = tick.change1h;
    const hitMove = absMove >= this.config.thresholds.priceMovePct;
    const hitHourly =
      Number.isFinite(change1h) && Math.abs(change1h) >= this.config.thresholds.priceMovePct;
    if (!hitMove && !hitHourly) return;

    const strong =
      absMove >= this.config.thresholds.priceMovePct * 2 ||
      (Number.isFinite(change1h) && Math.abs(change1h) >= this.config.thresholds.priceMovePct * 2);

    const direction = movePct >= 0 ? 'UP' : 'DOWN';
    await this.emit({
      type: 'market',
      source: tick.source,
      coalesceKey: `market:${symbol}`,
      tier: strong ? 'premium' : 'public',
      key: `market:${symbol}:${direction}`,
      symbol,
      title: `${symbol.replace('USDT', '')} ${direction} ${fmtPct(hitHourly ? change1h : movePct)}`,
      body: `${tick.name || coinId} $${fmtUsd(price)} via ${tick.source}. 24h: ${fmtPct(tick.change24h)}.`,
      url: `https://www.coingecko.com/en/coins/${coinId}`,
      fields: [
        { label: 'Price', value: `$${fmtUsd(price)}` },
        { label: 'Source', value: tick.source },
        { label: '1h', value: fmtPct(change1h) },
        { label: '24h', value: fmtPct(tick.change24h) },
      ],
    });
  }
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

function fmtPct(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

module.exports = { MarketSignal, coinIdToUsdt };
