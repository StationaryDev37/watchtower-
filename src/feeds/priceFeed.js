const axios = require('axios');
const { ResilientWs } = require('./resilientWs');

/**
 * Primary price source: Binance + Bybit book tickers over WSS (~200ms).
 * CoinGecko REST is coverage-tail fallback only.
 */
class PriceFeed {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.prices = new Map(); // symbol -> { price, source, ts, change1h? }
    this.sockets = [];
    this.fallbackTimer = null;
    this.stats = { updates: 0, fallbackPolls: 0 };
  }

  async start() {
    const symbols = this.config.price.symbols; // e.g. ['BTCUSDT','ETHUSDT']
    if (this.config.price.binanceEnabled) {
      const streams = symbols.map((s) => `${s.toLowerCase()}@bookTicker`).join('/');
      const binance = new ResilientWs({
        name: 'binance-price',
        url: `wss://fstream.binance.com/stream?streams=${streams}`,
        log: this.log,
        onMessage: (msg) => this.onBinance(msg),
      });
      binance.start();
      this.sockets.push(binance);
    }

    if (this.config.price.bybitEnabled) {
      const bybit = new ResilientWs({
        name: 'bybit-price',
        url: 'wss://stream.bybit.com/v5/public/linear',
        log: this.log,
        onOpen: (ws) => {
          ws.send(
            JSON.stringify({
              op: 'subscribe',
              args: symbols.map((s) => `tickers.${s}`),
            })
          );
        },
        onMessage: (msg) => this.onBybit(msg),
      });
      bybit.start();
      this.sockets.push(bybit);
    }

    // Slow CoinGecko fallback for coverage + 1h change metadata
    this.fallbackTimer = setInterval(() => {
      this.pollCoingecko().catch((err) =>
        this.log.debug('CoinGecko fallback failed', { error: err.message })
      );
    }, this.config.price.fallbackPollSec * 1000);
    if (this.fallbackTimer.unref) this.fallbackTimer.unref();
    await this.pollCoingecko().catch(() => {});

    this.log.info('PriceFeed started', {
      symbols,
      binance: this.config.price.binanceEnabled,
      bybit: this.config.price.bybitEnabled,
    });
  }

  async stop() {
    for (const s of this.sockets) s.stop();
    this.sockets = [];
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
  }

  onBinance(msg) {
    const d = msg.data || msg;
    if (!d?.s || d.b == null) return;
    this.setPrice(d.s.toUpperCase(), Number(d.b), 'binance');
  }

  onBybit(msg) {
    if (msg.topic?.startsWith('tickers.') && msg.data) {
      const d = msg.data;
      const sym = (d.symbol || '').toUpperCase();
      const px = Number(d.lastPrice || d.bid1Price);
      if (sym && Number.isFinite(px)) this.setPrice(sym, px, 'bybit');
    }
  }

  setPrice(symbol, price, source) {
    if (!Number.isFinite(price) || price <= 0) return;
    const prev = this.prices.get(symbol) || {};
    this.prices.set(symbol, {
      ...prev,
      symbol,
      price,
      source,
      ts: Date.now(),
    });
    this.stats.updates += 1;
  }

  async pollCoingecko() {
    const ids = this.config.coins.join(',');
    if (!ids) return;
    const headers = { Accept: 'application/json' };
    if (this.config.coingecko.apiKey) headers['x-cg-demo-api-key'] = this.config.coingecko.apiKey;
    const { data } = await axios.get(`${this.config.coingecko.baseUrl}/coins/markets`, {
      params: {
        vs_currency: 'usd',
        ids,
        price_change_percentage: '1h,24h',
      },
      headers,
      timeout: 20000,
    });
    this.stats.fallbackPolls += 1;
    for (const coin of data) {
      const symbol = `${coin.symbol.toUpperCase()}USDT`;
      const prev = this.prices.get(symbol) || {};
      const age = prev.ts ? Date.now() - prev.ts : Infinity;
      // Only overwrite if no fresh WSS tick in last 5s
      if (age > 5000) {
        this.setPrice(symbol, Number(coin.current_price), 'coingecko');
      }
      const cur = this.prices.get(symbol) || {};
      this.prices.set(symbol, {
        ...cur,
        id: coin.id,
        name: coin.name,
        change1h: Number(coin.price_change_percentage_1h_in_currency),
        change24h: Number(coin.price_change_percentage_24h_in_currency),
        volume: Number(coin.total_volume),
      });
    }
  }

  get(symbol) {
    return this.prices.get(symbol.toUpperCase()) || null;
  }

  all() {
    return [...this.prices.values()];
  }

  /** True if at least one venue delivered a tick recently */
  isLive(maxAgeMs = 15_000) {
    const now = Date.now();
    for (const p of this.prices.values()) {
      if (p.source !== 'coingecko' && p.ts && now - p.ts < maxAgeMs) return true;
    }
    return false;
  }

  status() {
    return {
      symbols: this.prices.size,
      live: this.isLive(),
      updates: this.stats.updates,
      fallbackPolls: this.stats.fallbackPolls,
      sockets: this.sockets.map((s) => s.status()),
    };
  }
}

module.exports = { PriceFeed };
