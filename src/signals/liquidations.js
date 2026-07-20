const { SignalPlugin } = require('./base');
const { ResilientWs } = require('../feeds/resilientWs');

/**
 * Cascade liquidation detector — Binance forceOrder + Bybit allLiquidation.
 * Fires when notional in one direction exceeds threshold inside the window.
 */
class LiquidationsSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'liquidations';
    this.sockets = [];
    this.buckets = new Map(); // symbol -> { buy: [], sell: [] } timestamps+notionals
    this.degraded = false;
  }

  async start() {
    // Per-symbol Binance forceOrder streams (memory-honest; no all-market firehose)
    if (this.config.liquidations.binanceEnabled) {
      const symbols = this.config.liquidations.symbols;
      const streams = symbols.map((s) => `${s.toLowerCase()}@forceOrder`).join('/');
      const perSym = new ResilientWs({
        name: 'binance-liq',
        url: `wss://fstream.binance.com/stream?streams=${streams}`,
        log: this.log,
        onMessage: (msg) => this.onBinance(msg.data || msg),
      });
      perSym.start();
      this.sockets.push(perSym);
    }

    if (this.config.liquidations.bybitEnabled) {
      const bybit = new ResilientWs({
        name: 'bybit-liq',
        url: 'wss://stream.bybit.com/v5/public/linear',
        log: this.log,
        onOpen: (ws) => {
          ws.send(
            JSON.stringify({
              op: 'subscribe',
              args: this.config.liquidations.symbols.map((s) => `allLiquidation.${s}`),
            })
          );
        },
        onMessage: (msg) => this.onBybit(msg),
      });
      bybit.start();
      this.sockets.push(bybit);
    }

    this.log.info('Liquidations signal started', {
      symbols: this.config.liquidations.symbols,
      windowSec: this.config.liquidations.windowSec,
      thresholdUsd: this.config.liquidations.thresholdUsd,
    });
  }

  async stop() {
    for (const s of this.sockets) s.stop();
    this.sockets = [];
  }

  status() {
    const connected = this.sockets.some((s) => s.status().connected);
    this.degraded = this.sockets.length > 0 && !connected;
    return {
      running: this.sockets.length > 0,
      degraded: this.degraded,
      sockets: this.sockets.map((s) => s.status()),
    };
  }

  onBinance(msg) {
    // { o: { s, S, q, p, ... } }  S = Sell means long liq
    const o = msg.o || msg;
    if (!o?.s) return;
    const symbol = String(o.s).toUpperCase();
    const qty = Number(o.q);
    const price = Number(o.p);
    if (!Number.isFinite(qty) || !Number.isFinite(price)) return;
    const notional = qty * price;
    // S=SELL → longs liquidated; S=BUY → shorts liquidated
    const side = String(o.S).toUpperCase() === 'SELL' ? 'long_liq' : 'short_liq';
    this.ingest(symbol, side, notional, 'binance');
  }

  onBybit(msg) {
    if (!msg.topic?.startsWith('allLiquidation.') || !msg.data) return;
    const rows = Array.isArray(msg.data) ? msg.data : [msg.data];
    for (const d of rows) {
      const symbol = String(d.symbol || '').toUpperCase();
      const qty = Number(d.size ?? d.qty);
      const price = Number(d.price);
      if (!symbol || !Number.isFinite(qty) || !Number.isFinite(price)) continue;
      const notional = qty * price;
      // Bybit side: Buy = short liq, Sell = long liq (same convention)
      const side = String(d.side).toUpperCase() === 'SELL' ? 'long_liq' : 'short_liq';
      this.ingest(symbol, side, notional, 'bybit');
    }
  }

  ingest(symbol, side, notional, venue) {
    const now = Date.now();
    const windowMs = this.config.liquidations.windowSec * 1000;
    const key = `${symbol}:${side}`;
    const bucket = this.buckets.get(key) || [];
    bucket.push({ t: now, notional, venue });
    const fresh = bucket.filter((x) => now - x.t <= windowMs);
    this.buckets.set(key, fresh);
    const total = fresh.reduce((s, x) => s + x.notional, 0);
    if (total < this.config.liquidations.thresholdUsd) return;

    // Reset bucket to avoid repeat spam; cooldown still applies on bus
    this.buckets.set(key, []);
    const dir = side === 'long_liq' ? 'LONGS' : 'SHORTS';
    this.emit({
      type: 'liquidations',
      tier: total >= this.config.liquidations.thresholdUsd * 3 ? 'premium' : 'public',
      key: `liq:${symbol}:${side}`,
      symbol,
      title: `${symbol} ${dir} liquidated $${fmtUsd(total)}`,
      body: `Cascade ≥$${fmtUsd(this.config.liquidations.thresholdUsd)} in ${this.config.liquidations.windowSec}s across ${venue}`,
      fields: [
        { label: 'Notional', value: `$${fmtUsd(total)}` },
        { label: 'Window', value: `${this.config.liquidations.windowSec}s` },
        { label: 'Side', value: dir },
      ],
    }).catch((err) => this.log.error('liq emit failed', { error: err.message }));
  }
}

function fmtUsd(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

module.exports = { LiquidationsSignal };
