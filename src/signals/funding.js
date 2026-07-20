const axios = require('axios');
const { SignalPlugin } = require('./base');

/**
 * Cross-venue perp funding edge.
 * Fires when one venue diverges >zσ from cross-venue median, or funding flips
 * on large notional. Leading indicator free bots usually don't cross-venue.
 */
class FundingSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'funding';
    this.timer = null;
    this.lastRates = new Map(); // venue:symbol -> rate
    this.pollCount = 0;
    this.degraded = false;
  }

  async start() {
    const every = this.config.funding.pollSec * 1000;
    await this.tick().catch((err) => this.log.warn('Funding initial tick failed', { error: err.message }));
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.degraded = true;
        this.log.warn('Funding tick failed', { error: err.message });
      });
    }, every);
    if (this.timer.unref) this.timer.unref();
    this.log.info('Funding signal started', {
      symbols: this.config.funding.symbols,
      zScore: this.config.funding.zScore,
    });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
  }

  status() {
    return {
      running: Boolean(this.timer),
      pollCount: this.pollCount,
      degraded: this.degraded,
      tracked: this.lastRates.size,
    };
  }

  async tick() {
    const symbols = this.config.funding.symbols;
    const rows = [];
    const results = await Promise.allSettled(
      symbols.flatMap((sym) => [
        this.fetchBinance(sym),
        this.fetchBybit(sym),
        this.fetchOkx(sym),
      ])
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) rows.push(r.value);
    }
    this.pollCount += 1;
    this.degraded = rows.length < symbols.length; // expect ≥1 venue per symbol ideally

    const bySymbol = new Map();
    for (const row of rows) {
      const list = bySymbol.get(row.symbol) || [];
      list.push(row);
      bySymbol.set(row.symbol, list);
      this.lastRates.set(`${row.venue}:${row.symbol}`, row.rate);
    }

    for (const [symbol, list] of bySymbol) {
      if (list.length < 2) continue;
      const rates = list.map((x) => x.rate);
      const median = medianOf(rates);
      const mad = medianOf(rates.map((r) => Math.abs(r - median))) || 1e-8;
      // Robust z via MAD
      for (const row of list) {
        const z = (0.6745 * (row.rate - median)) / mad;
        if (Math.abs(z) >= this.config.funding.zScore) {
          const dir = row.rate > median ? 'rich' : 'cheap';
          await this.emit({
            type: 'funding',
            tier: 'premium',
            key: `funding:${symbol}:${row.venue}:${dir}`,
            symbol,
            title: `${symbol} funding ${dir} on ${row.venue}`,
            body: `${row.venue} ${(row.rate * 100).toFixed(4)}% vs median ${(median * 100).toFixed(4)}% (z=${z.toFixed(2)})`,
            fields: list.map((x) => ({
              label: x.venue,
              value: `${(x.rate * 100).toFixed(4)}%`,
            })),
          });
        }
      }

      // Sign flip detection vs previous median snapshot
      for (const row of list) {
        const prevKey = `prev:${row.venue}:${symbol}`;
        const prev = this.lastRates.get(prevKey);
        this.lastRates.set(prevKey, row.rate);
        if (prev == null) continue;
        if (Math.sign(prev) !== Math.sign(row.rate) && Math.abs(row.rate) >= this.config.funding.flipAbs) {
          await this.emit({
            type: 'funding',
            tier: 'premium',
            key: `funding-flip:${symbol}:${row.venue}`,
            symbol,
            title: `${symbol} funding flipped on ${row.venue}`,
            body: `${(prev * 100).toFixed(4)}% → ${(row.rate * 100).toFixed(4)}%`,
            fields: [{ label: 'Venue', value: row.venue }],
          });
        }
      }
    }
  }

  async fetchBinance(symbol) {
    const { data } = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', {
      params: { symbol },
      timeout: 10000,
    });
    return { venue: 'binance', symbol, rate: Number(data.lastFundingRate) };
  }

  async fetchBybit(symbol) {
    const { data } = await axios.get('https://api.bybit.com/v5/market/tickers', {
      params: { category: 'linear', symbol },
      timeout: 10000,
    });
    const row = data?.result?.list?.[0];
    if (!row) return null;
    return { venue: 'bybit', symbol, rate: Number(row.fundingRate) };
  }

  async fetchOkx(symbol) {
    // OKX uses BTC-USDT-SWAP
    const inst = symbol.replace(/USDT$/, '') + '-USDT-SWAP';
    const { data } = await axios.get('https://www.okx.com/api/v5/public/funding-rate', {
      params: { instId: inst },
      timeout: 10000,
    });
    const row = data?.data?.[0];
    if (!row) return null;
    return { venue: 'okx', symbol, rate: Number(row.fundingRate) };
  }
}

function medianOf(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

module.exports = { FundingSignal };
