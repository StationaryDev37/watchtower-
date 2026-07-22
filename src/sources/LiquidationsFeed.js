const EventEmitter = require('events');
const { ResilientWs } = require('./ResilientWs');

/**
 * Cascade detector — exponential decay accumulator per side:
 *   L_t = L_{t-Δ} · exp(-Δ/τ) + notional_t    τ = CASCADE_TAU_S
 * Fire when L_t ≥ CASCADE_USD and opposite L is soft.
 */
class LiquidationsFeed extends EventEmitter {
  constructor(config, log, { breakers } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.breakers = breakers || {};
    this.sockets = [];
    this.acc = new Map(); // symbol -> { long: {L,t}, short: {L,t} }
    this.degraded = false;
  }

  async start() {
    this.symbols = this.config.liquidations.symbols.length
      ? this.config.liquidations.symbols
      : this.config.price.symbols.length
        ? this.config.price.symbols.slice(0, 8)
        : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

    if (this.config.liquidations.binanceEnabled) {
      const streams = this.symbols.map((s) => `${s.toLowerCase()}@forceOrder`).join('/');
      const ws = new ResilientWs({
        name: 'binance-liq',
        url: `wss://fstream.binance.com/stream?streams=${streams}`,
        log: this.log,
        breaker: this.breakers.binance,
        onMessage: (msg) => this.onBinance(msg.data || msg),
      });
      ws.start();
      this.sockets.push(ws);
    }

    if (this.config.liquidations.bybitEnabled) {
      const ws = new ResilientWs({
        name: 'bybit-liq',
        url: 'wss://stream.bybit.com/v5/public/linear',
        log: this.log,
        breaker: this.breakers.bybit,
        onOpen: (sock) => {
          sock.send(
            JSON.stringify({
              op: 'subscribe',
              args: this.symbols.map((s) => `allLiquidation.${s}`),
            })
          );
        },
        onMessage: (msg) => this.onBybit(msg),
      });
      ws.start();
      this.sockets.push(ws);
    }

    this.log.info('LiquidationsFeed started', {
      symbols: this.symbols.length,
      cascadeUsd: this.config.liquidations.cascadeUsd,
      tau: this.config.liquidations.tauSec,
    });
  }

  async stop() {
    for (const s of this.sockets) s.stop();
  }

  onBinance(msg) {
    const o = msg.o || msg;
    if (!o?.s) return;
    const symbol = String(o.s).toUpperCase();
    const notional = Number(o.q) * Number(o.p);
    if (!Number.isFinite(notional)) return;
    // S=SELL → longs liquidated
    const side = String(o.S).toUpperCase() === 'SELL' ? 'long' : 'short';
    this.ingest(symbol, side, notional, 'binance');
  }

  onBybit(msg) {
    if (!msg.topic?.startsWith('allLiquidation.') || !msg.data) return;
    const rows = Array.isArray(msg.data) ? msg.data : [msg.data];
    for (const d of rows) {
      const symbol = String(d.symbol || '').toUpperCase();
      const notional = Number(d.size ?? d.qty) * Number(d.price);
      if (!symbol || !Number.isFinite(notional)) continue;
      const side = String(d.side).toUpperCase() === 'SELL' ? 'long' : 'short';
      this.ingest(symbol, side, notional, 'bybit');
    }
  }

  ingest(symbol, side, notional, venue) {
    const now = Date.now();
    const tau = this.config.liquidations.tauSec;
    let state = this.acc.get(symbol);
    if (!state) {
      state = {
        long: { L: 0, t: now },
        short: { L: 0, t: now },
      };
      this.acc.set(symbol, state);
    }
    for (const s of ['long', 'short']) {
      const dt = (now - state[s].t) / 1000;
      state[s].L *= Math.exp(-dt / tau);
      state[s].t = now;
    }
    state[side].L += notional;

    const L = state[side].L;
    const opp = state[side === 'long' ? 'short' : 'long'].L;
    const thr = this.config.liquidations.cascadeUsd;
    if (L < thr) return;
    if (opp > L * (this.config.liquidations.softRatio || 0.25)) return;

    const asym = Math.log(Math.max(L, 1) / Math.max(opp, 1));
    this.emit('cascade', {
      symbol,
      side,
      L,
      opp,
      asym,
      venue,
      tier: L >= thr * 3 ? 'premium_alpha' : 'premium',
      ts: now,
    });
    // Soft reset to avoid immediate re-fire
    state[side].L *= 0.2;
  }

  status() {
    const connected = this.sockets.some((s) => s.status().connected);
    this.degraded = this.sockets.length > 0 && !connected;
    return {
      degraded: this.degraded,
      sockets: this.sockets.map((s) => s.status()),
      symbols: this.symbols?.length || 0,
    };
  }
}

module.exports = { LiquidationsFeed };
