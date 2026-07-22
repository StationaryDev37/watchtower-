const EventEmitter = require('events');
const axios = require('axios');
const { ResilientWs } = require('./ResilientWs');
const { median, robustSigma } = require('../math/mad');

/**
 * Cross-venue funding edge.
 *
 * r̄ = median(r_b, r_y, r_o)
 * σ_r = 1.4826 · MAD(rates)
 * d_v = (r_v - r̄) / max(σ_r, ε)
 * Fire when max|d_v| ≥ D_FIRE and venue OI ≥ OI_MIN.
 * Also fire on funding sign-flip after sustained |r| ≥ flipAbs.
 */
class FundingRouter extends EventEmitter {
  constructor(config, log, { breakers } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.breakers = breakers || {};
    this.rates = new Map(); // venue:symbol -> { rate, oi, ts }
    this.history = new Map(); // venue:symbol -> rate[]
    this.timer = null;
    this.sockets = [];
    this.degraded = false;
  }

  async start() {
    this.symbols = this.config.funding.symbols.length
      ? this.config.funding.symbols
      : this.config.price.symbols.length
        ? this.config.price.symbols
        : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

    // Binance markPrice stream carries lastFundingRate
    if (this.config.price.binanceEnabled) {
      const streams = this.symbols.map((s) => `${s.toLowerCase()}@markPrice@1s`).join('/');
      const ws = new ResilientWs({
        name: 'binance-funding',
        url: `wss://fstream.binance.com/stream?streams=${streams}`,
        log: this.log,
        breaker: this.breakers.binance,
        onMessage: (msg) => this.onBinance(msg),
      });
      ws.start();
      this.sockets.push(ws);
    }

    this.timer = setInterval(() => {
      this.pollRest().catch((err) => {
        this.degraded = true;
        this.log.debug('funding poll failed', { error: err.message });
      });
    }, this.config.funding.pollSec * 1000);
    if (this.timer.unref) this.timer.unref();

    await this.pollRest().catch(() => {});
    this.log.info('FundingRouter started', {
      symbols: this.symbols.length,
      dFire: this.config.funding.dFire,
    });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sockets) s.stop();
  }

  onBinance(msg) {
    const d = msg.data || msg;
    if (!d?.s || d.r == null) return;
    this.setRate('binance', d.s.toUpperCase(), Number(d.r), Number(d.i) || 0);
  }

  setRate(venue, symbol, rate, oiUsd = 0) {
    if (!Number.isFinite(rate)) return;
    const key = `${venue}:${symbol}`;
    this.rates.set(key, { venue, symbol, rate, oi: oiUsd, ts: Date.now() });
    const hist = this.history.get(key) || [];
    hist.push(rate);
    if (hist.length > 12) hist.shift();
    this.history.set(key, hist);
    this.evaluate(symbol);
  }

  async pollRest() {
    const results = await Promise.allSettled(
      this.symbols.flatMap((sym) => [
        this.fetchBinance(sym),
        this.fetchBybit(sym),
        this.fetchOkx(sym),
      ])
    );
    let ok = 0;
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        ok += 1;
        this.setRate(r.value.venue, r.value.symbol, r.value.rate, r.value.oi || 0);
      }
    }
    this.degraded = ok < this.symbols.length;
    this.breakers.okx?.[ok ? 'success' : 'failure']?.(new Error('funding poll'));
  }

  async fetchBinance(symbol) {
    const { data } = await axios.get('https://fapi.binance.com/fapi/v1/premiumIndex', {
      params: { symbol },
      timeout: 10000,
    });
    let oi = 0;
    try {
      const oiRes = await axios.get('https://fapi.binance.com/fapi/v1/openInterest', {
        params: { symbol },
        timeout: 8000,
      });
      oi = Number(oiRes.data.openInterest) * Number(data.markPrice);
    } catch {
      /* optional */
    }
    return { venue: 'binance', symbol, rate: Number(data.lastFundingRate), oi };
  }

  async fetchBybit(symbol) {
    const { data } = await axios.get('https://api.bybit.com/v5/market/tickers', {
      params: { category: 'linear', symbol },
      timeout: 10000,
    });
    const row = data?.result?.list?.[0];
    if (!row) return null;
    const oi = Number(row.openInterestValue || row.openInterest || 0);
    return { venue: 'bybit', symbol, rate: Number(row.fundingRate), oi };
  }

  async fetchOkx(symbol) {
    const inst = `${symbol.replace(/USDT$/, '')}-USDT-SWAP`;
    const { data } = await axios.get('https://www.okx.com/api/v5/public/funding-rate', {
      params: { instId: inst },
      timeout: 10000,
    });
    const row = data?.data?.[0];
    if (!row) return null;
    return { venue: 'okx', symbol, rate: Number(row.fundingRate), oi: 0 };
  }

  evaluate(symbol) {
    const rows = ['binance', 'bybit', 'okx']
      .map((v) => this.rates.get(`${v}:${symbol}`))
      .filter(Boolean);
    if (rows.length < 2) return;

    const rates = rows.map((r) => r.rate);
    const rBar = median(rates);
    const sigma = Math.max(robustSigma(rates), 1e-8);
    let maxD = 0;
    let worst = null;
    for (const row of rows) {
      const d = (row.rate - rBar) / sigma;
      if (Math.abs(d) > Math.abs(maxD)) {
        maxD = d;
        worst = row;
      }
    }

    if (
      worst &&
      Math.abs(maxD) >= this.config.funding.dFire &&
      (worst.oi >= this.config.funding.oiMinUsd || worst.oi === 0)
    ) {
      // Allow oi=0 for OKX when OI unavailable; still require D_FIRE
      if (worst.oi === 0 || worst.oi >= this.config.funding.oiMinUsd) {
        this.emit('divergence', {
          symbol,
          maxD,
          rBar,
          sigma,
          venue: worst.venue,
          rate: worst.rate,
          oi: worst.oi,
          venues: rows,
          tier: 'premium',
        });
      }
    }

    // Sign flip after sustained non-zero
    for (const row of rows) {
      const hist = this.history.get(`${row.venue}:${symbol}`) || [];
      if (hist.length < this.config.funding.flipLookback + 1) continue;
      const prev = hist[hist.length - 2];
      const prior = hist.slice(0, -1);
      const sustained = prior
        .slice(-this.config.funding.flipLookback)
        .every((r) => Math.abs(r) >= this.config.funding.flipAbs);
      if (sustained && Math.sign(prev) !== Math.sign(row.rate) && row.rate !== 0) {
        this.emit('flip', {
          symbol,
          venue: row.venue,
          from: prev,
          to: row.rate,
          tier: 'premium',
        });
      }
    }
  }

  status() {
    return {
      degraded: this.degraded,
      rates: this.rates.size,
      symbols: this.symbols?.length || 0,
      sockets: this.sockets.map((s) => s.status()),
    };
  }
}

module.exports = { FundingRouter };
