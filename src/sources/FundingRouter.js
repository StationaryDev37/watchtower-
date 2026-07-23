/**
 * FundingRouter — cross-venue perp funding edge (Commit B).
 * Binance markPrice + Bybit linear tickers + OKX funding-rate.
 *
 * r̄ = median(rates); σ = 1.4826·MAD; d_v = (r_v − r̄)/σ
 * Fire |d| ≥ D_FIRE and oi_max ≥ OI_MIN → premium / premium_alpha (|d|≥3).
 * Also fire funding.flip after crowded prior history changes sign.
 */
'use strict';

const { EventEmitter } = require('events');
const { ResilientWs } = require('./ResilientWs');
const { CircuitBreaker } = require('./CircuitBreaker');

const BINANCE_FWSS = 'wss://fstream.binance.com/stream';
const BYBIT_WSS = 'wss://stream.bybit.com/v5/public/linear';
const OKX_WSS = 'wss://ws.okx.com:8443/ws/v5/public';

const FLIP_HIST = 3;
const FLIP_THRESH = 0.0001;

class FundingRouter extends EventEmitter {
  constructor(config, log, { breakers } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.frameworkBreakers = breakers || {};
    this.rates = new Map();
    this.sockets = [];
    this.state = { binance: 'init', bybit: 'init', okx: 'init' };
    this.breakers = {
      binance: new CircuitBreaker('binance-funding'),
      bybit: new CircuitBreaker('bybit-funding'),
      okx: new CircuitBreaker('okx-funding'),
    };
    this.degraded = false;
  }

  get dFire() {
    return this.config?.funding?.dFire ?? Number(process.env.D_FIRE ?? 2.0);
  }
  get oiMin() {
    return this.config?.funding?.oiMinUsd ?? Number(process.env.OI_MIN_USD ?? 50_000_000);
  }
  get flipHist() {
    return this.config?.funding?.flipLookback ?? FLIP_HIST;
  }
  get flipThresh() {
    return this.config?.funding?.flipAbs ?? FLIP_THRESH;
  }

  async start() {
    const fromEnv = (process.env.FUNDING_UNIVERSE || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    this.universe = (
      fromEnv.length
        ? fromEnv
        : this.config?.funding?.symbols?.length
          ? this.config.funding.symbols
          : this.config?.price?.symbols?.length
            ? this.config.price.symbols
            : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
    ).map((s) => String(s).toUpperCase());

    for (const s of this.universe) {
      this.rates.set(s, {
        binance: null,
        bybit: null,
        okx: null,
        lastFire: 0,
        history: [],
        _lastHistTs: 0,
      });
    }

    this._binance();
    this._bybit();
    this._okx();
    this.log?.info?.('FundingRouter started', {
      symbols: this.universe.length,
      dFire: this.dFire,
      oiMin: this.oiMin,
    });
  }

  async stop() {
    for (const s of this.sockets) s.stop();
    this.sockets = [];
  }

  _binance() {
    const streams = this.universe.map((s) => `${s.toLowerCase()}@markPrice@1s`).join('/');
    const ws = new ResilientWs({
      name: 'binance-funding',
      url: `${BINANCE_FWSS}?streams=${streams}`,
      log: this.log,
      breaker: this.breakers.binance,
      onOpen: () => this._setState('binance', 'up'),
      onMessage: (msg) => {
        try {
          const d = msg.data || msg;
          if (!d || (d.e && d.e !== 'markPriceUpdate')) return;
          if (d.s == null || d.r == null) return;
          const sym = String(d.s).toUpperCase();
          if (!this.rates.has(sym)) return;
          const row = this.rates.get(sym);
          row.binance = { r: parseFloat(d.r), oi: row.binance?.oi ?? null, ts: Date.now() };
          this._evaluate(sym);
          this.breakers.binance.ok();
          this.frameworkBreakers.binance?.ok?.();
        } catch (err) {
          this.breakers.binance.fail(err);
        }
      },
    });
    ws.start();
    this.sockets.push(ws);
  }

  _bybit() {
    const ws = new ResilientWs({
      name: 'bybit-funding',
      url: BYBIT_WSS,
      log: this.log,
      breaker: this.breakers.bybit,
      onOpen: (sock) => {
        this._setState('bybit', 'up');
        sock.send(
          JSON.stringify({
            op: 'subscribe',
            args: this.universe.map((s) => `tickers.${s}`),
          })
        );
      },
      onMessage: (msg) => {
        try {
          if (!msg.topic?.startsWith('tickers.')) return;
          const sym = String(msg.topic.split('.')[1] || '').toUpperCase();
          if (!this.rates.has(sym)) return;
          const d = Array.isArray(msg.data) ? msg.data[0] : msg.data || {};
          const r = d.fundingRate != null ? parseFloat(d.fundingRate) : null;
          const oi = d.openInterestValue != null ? parseFloat(d.openInterestValue) : null;
          const row = this.rates.get(sym);
          if (r !== null || oi !== null) {
            row.bybit = {
              r: r ?? row.bybit?.r ?? null,
              oi: oi ?? row.bybit?.oi ?? null,
              ts: Date.now(),
            };
            this._evaluate(sym);
          }
          this.breakers.bybit.ok();
          this.frameworkBreakers.bybit?.ok?.();
        } catch (err) {
          this.breakers.bybit.fail(err);
        }
      },
    });
    ws.start();
    this.sockets.push(ws);
  }

  _okx() {
    const ws = new ResilientWs({
      name: 'okx-funding',
      url: OKX_WSS,
      log: this.log,
      breaker: this.breakers.okx,
      onOpen: (sock) => {
        this._setState('okx', 'up');
        const args = this.universe.map((s) => ({
          channel: 'funding-rate',
          instId: s.replace('USDT', '-USDT-SWAP'),
        }));
        sock.send(JSON.stringify({ op: 'subscribe', args }));
      },
      onMessage: (msg) => {
        try {
          if (msg.arg?.channel !== 'funding-rate' || !Array.isArray(msg.data)) return;
          for (const d of msg.data) {
            const sym = String(d.instId || '')
              .replace('-USDT-SWAP', 'USDT')
              .toUpperCase();
            if (!this.rates.has(sym)) continue;
            const r = parseFloat(d.fundingRate);
            const row = this.rates.get(sym);
            row.okx = { r, oi: row.okx?.oi ?? null, ts: Date.now() };
            this._evaluate(sym);
          }
          this.breakers.okx.ok();
          this.frameworkBreakers.okx?.ok?.();
        } catch (err) {
          this.breakers.okx.fail(err);
        }
      },
    });
    ws.start();
    this.sockets.push(ws);
  }

  _evaluate(sym) {
    const row = this.rates.get(sym);
    const now = Date.now();
    if (now - row.lastFire < 60_000) return;

    const venues = ['binance', 'bybit', 'okx'].filter((v) => row[v]?.r != null);
    if (venues.length < 3) return;
    const rs = venues.map((v) => row[v].r);
    const oiMax = Math.max(...venues.map((v) => row[v].oi || 0));

    const sorted = rs.slice().sort((a, b) => a - b);
    const med = sorted[1]; // n=3 median
    const dev = rs.map((r) => Math.abs(r - med));
    const mad = dev.slice().sort((a, b) => a - b)[1];
    const sigma = 1.4826 * mad || 1e-9;
    const devs = venues.map((v, i) => ({ v, d: (rs[i] - med) / sigma, r: rs[i] }));
    const worst = devs.reduce((a, b) => (Math.abs(b.d) > Math.abs(a.d) ? b : a));

    if (Math.abs(worst.d) >= this.dFire && oiMax >= this.oiMin) {
      row.lastFire = now;
      const payload = {
        symbol: sym,
        ts: now,
        venue: worst.v,
        venue_rate: worst.r,
        consensus: med,
        sigma,
        deviation: worst.d,
        maxD: worst.d,
        rBar: med,
        rate: worst.r,
        oi: oiMax,
        oi_max: oiMax,
        venues: venues.map((v, i) => ({ venue: v, rate: rs[i], oi: row[v].oi || 0 })),
        tier: Math.abs(worst.d) >= 3.0 ? 'premium_alpha' : 'premium',
      };
      this.emit('funding.divergence', payload);
      this.emit('divergence', payload);
    }

    const prev = row.history[row.history.length - 1];
    if (prev != null && Math.sign(prev) !== Math.sign(med) && Math.sign(med) !== 0) {
      const look = row.history.slice(-this.flipHist);
      const crowdedPrior = look.length >= this.flipHist && look.every((x) => Math.abs(x) >= this.flipThresh);
      if (crowdedPrior) {
        row.lastFire = now;
        const flip = {
          symbol: sym,
          ts: now,
          prior: prev,
          current: med,
          from: prev,
          to: med,
          history: look,
          venue: worst?.v || 'consensus',
          tier: 'premium',
        };
        this.emit('funding.flip', flip);
        this.emit('flip', flip);
      }
    }

    if (!row._lastHistTs || now - row._lastHistTs > 30_000) {
      row.history.push(med);
      row._lastHistTs = now;
      if (row.history.length > 12) row.history.shift();
    }
  }

  _setState(src, s) {
    if (this.state[src] === s) return;
    this.state[src] = s;
    this.emit('source-state', { source: src, state: s });
  }

  snapshot() {
    return {
      state: { ...this.state },
      tracked: this.universe?.length || 0,
      breakers: Object.fromEntries(
        Object.entries(this.breakers).map(([k, b]) => [k, b.state])
      ),
    };
  }

  status() {
    this.degraded = Object.values(this.state).filter((s) => s === 'up').length < 2;
    return {
      ...this.snapshot(),
      degraded: this.degraded,
      rates: this.rates.size,
      symbols: this.universe?.length || 0,
      sockets: this.sockets.map((s) => s.status()),
    };
  }
}

module.exports = { FundingRouter };
