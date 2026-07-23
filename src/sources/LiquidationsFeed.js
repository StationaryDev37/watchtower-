/**
 * LiquidationsFeed — exponential-decay cascade detector (Commit B).
 *   L_t = L · e^(-Δ/τ) + notional
 * Fire when L ≥ CASCADE_USD and opposite · ASYM < L.
 */
'use strict';

const { EventEmitter } = require('events');
const { ResilientWs } = require('./ResilientWs');
const { CircuitBreaker } = require('./CircuitBreaker');

const BINANCE_FWSS = 'wss://fstream.binance.com/stream';
const BYBIT_WSS = 'wss://stream.bybit.com/v5/public/linear';

class LiquidationsFeed extends EventEmitter {
  constructor(config, log, { breakers } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.frameworkBreakers = breakers || {};
    this.side = {
      long: { L: 0, ts: Date.now(), top: null, notionalBySym: new Map() },
      short: { L: 0, ts: Date.now(), top: null, notionalBySym: new Map() },
    };
    this.breakers = {
      binance: new CircuitBreaker('binance-liq'),
      bybit: new CircuitBreaker('bybit-liq'),
    };
    this.state = { binance: 'init', bybit: 'init' };
    this.lastFire = 0;
    this.sockets = [];
    this._decayTimer = null;
    this.degraded = false;
  }

  get cascadeUsd() {
    return this.config?.liquidations?.cascadeUsd ?? Number(process.env.CASCADE_USD ?? 5_000_000);
  }
  get tauMs() {
    const sec = this.config?.liquidations?.tauSec ?? Number(process.env.CASCADE_TAU_S ?? 30);
    return sec * 1000;
  }
  get asym() {
    return this.config?.liquidations?.asym ?? Number(process.env.CASCADE_ASYM ?? 4.0);
  }

  async start() {
    if (this.config?.liquidations?.binanceEnabled !== false) this._binance();
    if (this.config?.liquidations?.bybitEnabled !== false) this._bybit();
    this._decayTimer = setInterval(() => this._decay(), 1000);
    if (this._decayTimer.unref) this._decayTimer.unref();
    this.log?.info?.('LiquidationsFeed started', {
      cascadeUsd: this.cascadeUsd,
      tauMs: this.tauMs,
      asym: this.asym,
    });
  }

  async stop() {
    if (this._decayTimer) clearInterval(this._decayTimer);
    for (const s of this.sockets) s.stop();
    this.sockets = [];
  }

  _binance() {
    const ws = new ResilientWs({
      name: 'binance-liq',
      url: `${BINANCE_FWSS}?streams=!forceOrder@arr`,
      log: this.log,
      breaker: this.breakers.binance,
      onOpen: () => this._setState('binance', 'up'),
      onMessage: (msg) => {
        try {
          const d = (msg.data || msg)?.o || (msg.data || msg);
          if (!d?.s) return;
          const side = String(d.S).toUpperCase() === 'SELL' ? 'long' : 'short';
          const notional = parseFloat(d.p) * parseFloat(d.q);
          if (!Number.isFinite(notional)) return;
          this._ingest(side, String(d.s).toUpperCase(), notional);
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
      name: 'bybit-liq',
      url: BYBIT_WSS,
      log: this.log,
      breaker: this.breakers.bybit,
      onOpen: (sock) => {
        this._setState('bybit', 'up');
        sock.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.USDT'] }));
      },
      onMessage: (msg) => {
        try {
          if (!msg.topic?.startsWith('allLiquidation') || !msg.data) return;
          const rows = Array.isArray(msg.data) ? msg.data : [msg.data];
          for (const d of rows) {
            const side = String(d.side).toUpperCase() === 'SELL' ? 'long' : 'short';
            const notional = parseFloat(d.price) * parseFloat(d.size ?? d.qty);
            if (!Number.isFinite(notional)) continue;
            this._ingest(side, String(d.symbol || '').toUpperCase(), notional);
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

  _ingest(side, sym, notional) {
    if (!sym) return;
    const now = Date.now();
    const s = this.side[side];
    const dt = now - s.ts;
    s.L = s.L * Math.exp(-dt / this.tauMs) + notional;
    s.ts = now;
    s.notionalBySym.set(
      sym,
      (s.notionalBySym.get(sym) || 0) * Math.exp(-dt / this.tauMs) + notional
    );
    let top = null;
    let val = -1;
    for (const [k, v] of s.notionalBySym) {
      if (v > val) {
        val = v;
        top = k;
      }
    }
    s.top = { symbol: top, notional: val };
    this._maybeFire(side);
  }

  _decay() {
    const now = Date.now();
    for (const side of ['long', 'short']) {
      const s = this.side[side];
      const dt = now - s.ts;
      s.L = s.L * Math.exp(-dt / this.tauMs);
      s.ts = now;
      for (const [k, v] of s.notionalBySym) {
        const nv = v * Math.exp(-dt / this.tauMs);
        if (nv < 1_000) s.notionalBySym.delete(k);
        else s.notionalBySym.set(k, nv);
      }
    }
  }

  _maybeFire(side) {
    const now = Date.now();
    if (now - this.lastFire < 45_000) return;
    const s = this.side[side];
    const opp = this.side[side === 'long' ? 'short' : 'long'];
    if (s.L < this.cascadeUsd) return;
    if (opp.L * this.asym >= s.L) return;
    this.lastFire = now;
    const topShare = s.top?.notional ? s.top.notional / s.L : 0;
    const payload = {
      ts: now,
      side,
      notional_30s: s.L,
      opposite_30s: opp.L,
      L: s.L,
      opp: opp.L,
      asym: Math.log(Math.max(1, s.L) / Math.max(1, opp.L)),
      top_symbol: s.top?.symbol || null,
      top_symbol_share: topShare,
      symbol: s.top?.symbol || null,
      venue: this.state.binance === 'up' ? 'binance' : 'bybit',
      tier: s.L >= this.cascadeUsd * 4 ? 'premium_alpha' : 'premium',
    };
    this.emit('liquidations.cascade', payload);
    this.emit('cascade', payload);
  }

  _setState(src, s) {
    if (this.state[src] === s) return;
    this.state[src] = s;
    this.emit('source-state', { source: src, state: s });
  }

  snapshot() {
    return {
      state: { ...this.state },
      long_L: this.side.long.L,
      short_L: this.side.short.L,
    };
  }

  status() {
    const connected = this.sockets.some((s) => s.status().connected);
    this.degraded = this.sockets.length > 0 && !connected;
    return {
      ...this.snapshot(),
      degraded: this.degraded,
      sockets: this.sockets.map((s) => s.status()),
    };
  }
}

module.exports = { LiquidationsFeed };
