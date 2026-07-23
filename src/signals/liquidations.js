/**
 * Liquidations signal — cascade envelopes for AlertBus (premium / premium_alpha).
 */
'use strict';

const { SignalPlugin } = require('./base');

class LiquidationsSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'liquidations';
    this.liquidationsFeed = null;
    this.stats = { cascades: 0 };
  }

  async start() {
    if (!this.liquidationsFeed) {
      this.log.warn('liquidations signal: LiquidationsFeed not injected');
      return;
    }
    this._on = (e) => {
      if (this.paused) return;
      this.stats.cascades += 1;
      const symbol = e.top_symbol || e.symbol || 'MULTI';
      const base = String(symbol).replace(/USDT$/, '');
      const dir = e.side === 'long' ? 'LONGS' : 'SHORTS';
      const L = e.notional_30s ?? e.L;
      const opp = e.opposite_30s ?? e.opp;
      const asym =
        e.asym ?? Math.log(Math.max(1, L) / Math.max(1, opp));
      this.emit({
        type: 'liquidations',
        signal_type: 'liquidations.cascade',
        source: e.venue,
        coalesceKey: symbol,
        symbol,
        tier: e.tier === 'premium_alpha' ? 'premium_alpha' : 'premium',
        lane: e.tier === 'premium_alpha' ? 'premium_alpha' : 'premium',
        ts: e.ts || Date.now(),
        features: {
          x4: Math.log(Math.max(1, L) / Math.max(1, opp)),
          liq_asym: asym,
          z: 0,
          zVol: 0,
          funding_dev: 0,
        },
        key: `liq:${symbol}:${e.side}:${Math.round((e.ts || Date.now()) / 30000)}`,
        title: `${base} ${dir} cascade $${fmtUsd(L)}`,
        body: `Decay-accumulator ≥$${fmtUsd(this.config.liquidations.cascadeUsd)} (τ=${this.config.liquidations.tauSec}s) via ${e.venue}`,
        payload: e,
        fields: [
          { label: 'L', value: `$${fmtUsd(L)}` },
          { label: 'Opposite', value: `$${fmtUsd(opp)}` },
          { label: 'Asym', value: Number(asym).toFixed(2) },
          { label: 'Top share', value: `${((e.top_symbol_share || 0) * 100).toFixed(0)}%` },
        ],
      }).catch((err) => this.log.error('liq emit failed', { error: err.message }));
    };
    this.liquidationsFeed.on('liquidations.cascade', this._on);
    this.log.info('Liquidations signal subscribed');
  }

  async stop() {
    if (this.liquidationsFeed && this._on) {
      this.liquidationsFeed.off('liquidations.cascade', this._on);
    }
  }

  status() {
    return {
      running: Boolean(this.liquidationsFeed) && !this.paused,
      paused: this.paused,
      ...this.stats,
      feed: this.liquidationsFeed?.status?.(),
    };
  }

  metrics() {
    return this.liquidationsFeed?.snapshot?.() || {};
  }
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

module.exports = { LiquidationsSignal };
