/**
 * PriceRouter — Binance + Bybit WSS primary, CoinGecko poll fallback.
 * Spike math via RollingMAD (1s resample, W=5m):
 *   z = 0.6745 · (p − med) / MAD
 * Fire |z| ≥ Z_FIRE and mad/med ≥ NOISE_FLOOR; vol confirm → premium.
 */
'use strict';

const { EventEmitter } = require('events');
const axios = require('axios');
const { RollingWindow, madZ } = require('./RollingMAD');
const { ResilientWs } = require('./ResilientWs');

class PriceRouter extends EventEmitter {
  constructor(config, log, { breakers } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.breakers = breakers || {};
    this.sockets = [];
    this.prices = new Map();
    this.priceWin = new Map();
    this.volBucket = new Map();
    this.lastFire = new Map();
    this.lastTick = new Map();
    this.stats = { ticks: 0, spikes: 0, fallbackPolls: 0 };
    this.degraded = false;
    this.state = { binance: 'init', bybit: 'init', coingecko: 'idle' };
    this.symbols = [];
    this.fallbackTimer = null;
    this.silenceTimer = null;
  }

  get windowMs() {
    return this.config.price.windowSec * 1000 || Number(process.env.PRICE_WINDOW_MS) || 300_000;
  }
  get volWindowMs() {
    return Number(process.env.VOL_WINDOW_MS) || 900_000;
  }
  get zFire() {
    return this.config.price.zFire;
  }
  get zVolFire() {
    return this.config.price.zVolFire;
  }
  get noiseFloor() {
    return this.config.price.noiseFloor;
  }
  get cooldownMs() {
    return Number(process.env.SPIKE_COOLDOWN_MS) || 60_000;
  }
  get silenceMs() {
    return this.config.price.silentMs || 5000;
  }

  async start() {
    this.symbols = await this.resolveUniverse();
    for (const s of this.symbols) {
      this.priceWin.set(s, new RollingWindow(this.windowMs));
      this.volBucket.set(s, {
        curMinute: 0,
        cur: 0,
        hist: new RollingWindow(this.volWindowMs),
      });
    }

    if (this.config.price.binanceEnabled) {
      const chunks = chunk(this.symbols, 40);
      for (const [i, group] of chunks.entries()) {
        const streams = group.map((s) => `${s.toLowerCase()}@trade`).join('/');
        const ws = new ResilientWs({
          name: `binance-price-${i}`,
          url: `wss://stream.binance.com:9443/stream?streams=${streams}`,
          log: this.log,
          breaker: this.breakers.binance,
          onOpen: () => this._setState('binance', 'up'),
          onMessage: (msg) => this.onBinance(msg),
        });
        ws.start();
        this.sockets.push(ws);
      }
    }

    if (this.config.price.bybitEnabled) {
      const ws = new ResilientWs({
        name: 'bybit-price',
        url: 'wss://stream.bybit.com/v5/public/spot',
        log: this.log,
        breaker: this.breakers.bybit,
        onOpen: (sock) => {
          this._setState('bybit', 'up');
          for (const batch of chunk(this.symbols, 10)) {
            sock.send(
              JSON.stringify({
                op: 'subscribe',
                args: batch.map((s) => `publicTrade.${s}`),
              })
            );
          }
        },
        onMessage: (msg) => this.onBybit(msg),
      });
      ws.start();
      this.sockets.push(ws);
    }

    this.fallbackTimer = setInterval(() => {
      this._maybePollCG().catch((err) => {
        this.breakers.coingecko?.failure?.(err);
        this.breakers.coingecko?.fail?.();
      });
    }, this.config.price.fallbackPollSec * 1000);
    if (this.fallbackTimer.unref) this.fallbackTimer.unref();

    this.silenceTimer = setInterval(() => this._checkSilence(), 1000);
    if (this.silenceTimer.unref) this.silenceTimer.unref();

    await this._maybePollCG().catch(() => {});
    this.log.info('PriceRouter started', {
      symbols: this.symbols.length,
      zFire: this.zFire,
      zVolFire: this.zVolFire,
    });
  }

  async stop() {
    for (const s of this.sockets) s.stop();
    this.sockets = [];
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
  }

  async resolveUniverse() {
    const configured = this.config.price.symbols;
    if (configured.length) return configured.map((s) => s.toUpperCase());
    return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  }

  onBinance(msg) {
    try {
      const d = msg.data || msg;
      if (!d) return;
      // trade stream
      if (d.e === 'trade' || (d.s && d.p != null && d.q != null)) {
        const sym = String(d.s).toUpperCase();
        const px = parseFloat(d.p);
        const qty = parseFloat(d.q);
        this._ingest(sym, px, qty, d.T || Date.now(), 'binance');
        this.breakers.binance?.success?.();
        this.breakers.binance?.ok?.();
        return;
      }
      // bookTicker fallback
      if (d.s && d.b != null) {
        this._ingest(String(d.s).toUpperCase(), Number(d.b), 0, Date.now(), 'binance');
      }
    } catch {
      this.breakers.binance?.failure?.(new Error('parse'));
      this.breakers.binance?.fail?.();
    }
  }

  onBybit(msg) {
    try {
      if (msg.topic?.startsWith('publicTrade.') && Array.isArray(msg.data)) {
        for (const t of msg.data) {
          this._ingest(
            String(t.s).toUpperCase(),
            parseFloat(t.p),
            parseFloat(t.v),
            t.T || Date.now(),
            'bybit'
          );
        }
        this.breakers.bybit?.success?.();
        this.breakers.bybit?.ok?.();
        return;
      }
      if (msg.topic?.startsWith('tickers.') && msg.data) {
        const d = msg.data;
        const px = Number(d.lastPrice || d.bid1Price);
        if (d.symbol && Number.isFinite(px)) {
          this._ingest(String(d.symbol).toUpperCase(), px, 0, Date.now(), 'bybit');
        }
      }
    } catch {
      this.breakers.bybit?.failure?.(new Error('parse'));
      this.breakers.bybit?.fail?.();
    }
  }

  async _maybePollCG() {
    // CoinGecko only when both venue breakers refuse traffic (or feeds silent/degraded).
    const binanceOk = this.breakers.binance?.allow?.() !== false;
    const bybitOk = this.breakers.bybit?.allow?.() !== false;
    const wssLive =
      (this.state.binance === 'up' || this.state.bybit === 'up') && this.isLive();
    if ((binanceOk || bybitOk) && wssLive) return;

    const ids = this.config.coins.join(',') || 'bitcoin,ethereum,solana';
    const headers = { Accept: 'application/json' };
    if (this.config.coingecko.apiKey) headers['x-cg-demo-api-key'] = this.config.coingecko.apiKey;
    try {
      const { data } = await axios.get(`${this.config.coingecko.baseUrl}/coins/markets`, {
        params: { vs_currency: 'usd', ids, per_page: 50, page: 1 },
        headers,
        timeout: 8000,
      });
      this.stats.fallbackPolls += 1;
      this.breakers.coingecko?.success?.();
      this.breakers.coingecko?.ok?.();
      this._setState('coingecko', 'up');
      const now = Date.now();
      for (const row of data) {
        const sym = coinIdToUsdt(row.id, row.symbol);
        if (!this.priceWin.has(sym) && !this.symbols.includes(sym)) continue;
        this._ingest(sym, row.current_price, 0, now, 'coingecko');
        const cur = this.prices.get(sym) || {};
        this.prices.set(sym, {
          ...cur,
          id: row.id,
          name: row.name,
          change1h: Number(row.price_change_percentage_1h_in_currency),
          change24h: Number(row.price_change_percentage_24h_in_currency),
        });
      }
    } catch (err) {
      this.breakers.coingecko?.failure?.(err);
      this.breakers.coingecko?.fail?.();
      this._setState('coingecko', 'down');
    }
  }

  _ingest(symbol, price, qty, ts, source) {
    if (!Number.isFinite(price) || price <= 0) return;
    if (!this.priceWin.has(symbol)) {
      // lazily accept configured symbols
      if (!this.symbols.includes(symbol)) return;
      this.priceWin.set(symbol, new RollingWindow(this.windowMs));
      this.volBucket.set(symbol, {
        curMinute: 0,
        cur: 0,
        hist: new RollingWindow(this.volWindowMs),
      });
    }

    const now = ts || Date.now();
    this.lastTick.set(`${symbol}|${source}`, now);
    this.stats.ticks += 1;

    const prev = this.prices.get(symbol) || {};
    this.prices.set(symbol, { ...prev, symbol, price, source, ts: now });
    this.emit('tick', { symbol, price, ts: now, source });

    const win = this.priceWin.get(symbol);
    const last = win.buf.length ? win.buf[win.buf.length - 1].ts : 0;
    if (now - last >= 1000) win.push(now, price);

    const vb = this.volBucket.get(symbol);
    const minute = Math.floor(now / 60_000);
    if (vb.curMinute === 0) vb.curMinute = minute;
    if (minute !== vb.curMinute) {
      vb.hist.push(vb.curMinute * 60_000, vb.cur);
      vb.curMinute = minute;
      vb.cur = 0;
    }
    vb.cur += qty * price;

    const vals = win.values();
    if (vals.length < 30) return;
    const { z, med, mad } = madZ(vals, price);
    if (!(med > 0)) return;
    const relMad = mad / med;
    if (!(relMad >= this.noiseFloor)) return;

    const volHist = vb.hist.values();
    let zVol = 0;
    if (volHist.length >= 8) zVol = madZ(volHist, vb.cur).z;

    if (Math.abs(z) >= this.zFire) {
      const lf = this.lastFire.get(symbol) || 0;
      if (now - lf < this.cooldownMs) return;
      this.lastFire.set(symbol, now);
      this.stats.spikes += 1;
      const tier = zVol >= this.zVolFire ? 'premium' : 'public';
      const degraded = this.state.binance !== 'up' && this.state.bybit !== 'up';
      this.emit('spike', {
        symbol,
        price,
        z,
        zVol,
        mad,
        med,
        relMad,
        ts: now,
        tier,
        source,
        degraded,
      });
      if (zVol >= this.zVolFire) {
        this.emit('volume-spike', { symbol, zVol, price, ts: now, tier, source, degraded });
      }
    }
  }

  _checkSilence() {
    const now = Date.now();
    let anyLive = false;
    for (const src of ['binance', 'bybit']) {
      const anyRecent = this.symbols.some((sym) => {
        const t = this.lastTick.get(`${sym}|${src}`) || 0;
        return now - t < this.silenceMs;
      });
      if (anyRecent) {
        anyLive = true;
        if (this.state[src] !== 'up') this._setState(src, 'up');
      } else if (this.state[src] === 'up') {
        this._setState(src, 'silent');
        this.breakers[src]?.failure?.(new Error('silence'));
        this.breakers[src]?.fail?.();
      }
    }
    this.degraded = !anyLive && this.sockets.length > 0;
  }

  _setState(src, s) {
    if (this.state[src] === s) return;
    this.state[src] = s;
    this.emit('source-state', { source: src, state: s });
  }

  get(symbol) {
    return this.prices.get(String(symbol).toUpperCase()) || null;
  }

  isLive(maxAgeMs = 15_000) {
    const now = Date.now();
    for (const p of this.prices.values()) {
      if (p.source !== 'coingecko' && p.ts && now - p.ts < maxAgeMs) return true;
    }
    return false;
  }

  status() {
    return {
      live: this.isLive(),
      degraded: this.degraded,
      state: { ...this.state },
      symbols: this.prices.size,
      ticks: this.stats.ticks,
      spikes: this.stats.spikes,
      fallbackPolls: this.stats.fallbackPolls,
      sockets: this.sockets.map((s) => s.status()),
      breakers: Object.fromEntries(
        Object.entries(this.breakers).map(([k, b]) => [k, b.state || b.status?.()?.state])
      ),
    };
  }

  snapshot() {
    return this.status();
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function coinIdToUsdt(id, symbol) {
  const map = {
    bitcoin: 'BTCUSDT',
    ethereum: 'ETHUSDT',
    solana: 'SOLUSDT',
    binancecoin: 'BNBUSDT',
    ripple: 'XRPUSDT',
  };
  return map[id] || `${String(symbol || id).toUpperCase()}USDT`;
}

module.exports = { PriceRouter };
