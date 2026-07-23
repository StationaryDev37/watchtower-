/**
 * Thin subscriber: PriceRouter does the math; this packages AlertBus envelopes.
 */
'use strict';

const { SignalPlugin } = require('./base');

class MarketSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'market';
    this.priceRouter = null;
    this.stats = { spikes: 0 };
    this._onSpike = null;
    this._onVol = null;
  }

  async start() {
    if (!this.priceRouter) {
      this.log.warn('market signal: PriceRouter not injected');
      return;
    }
    this._onSpike = (e) => {
      if (this.paused) return;
      this.handleSpike(e).catch((err) =>
        this.log.error('spike handle failed', { error: err.message })
      );
    };
    this._onVol = (e) => {
      if (this.paused) return;
      this.handleVol(e).catch((err) =>
        this.log.error('vol spike handle failed', { error: err.message })
      );
    };
    this.priceRouter.on('spike', this._onSpike);
    this.priceRouter.on('volume-spike', this._onVol);
    this.priceRouter.on('source-state', (s) => {
      this.log.debug?.('price source-state', s);
    });
    this.log.info('Market signal subscribed to PriceRouter');
  }

  async stop() {
    if (this.priceRouter && this._onSpike) {
      this.priceRouter.off('spike', this._onSpike);
      this.priceRouter.off('volume-spike', this._onVol);
    }
  }

  status() {
    return {
      running: Boolean(this.priceRouter) && !this.paused,
      paused: this.paused,
      spikes: this.stats.spikes,
      feed: this.priceRouter?.status?.(),
    };
  }

  metrics() {
    return this.priceRouter?.snapshot?.() || {};
  }

  async handleSpike(e) {
    this.stats.spikes += 1;
    const dir = e.z >= 0 ? 'UP' : 'DOWN';
    const base = e.symbol.replace(/USDT$/, '');
    await this.emit({
      type: 'market',
      signal_type: 'market.spike',
      source: e.source,
      coalesceKey: e.symbol,
      symbol: e.symbol,
      tier: e.tier,
      degraded: e.degraded,
      entryPrice: e.price,
      ts: e.ts,
      features: {
        z: Math.abs(e.z),
        zVol: Math.max(0, e.zVol || 0),
        funding_dev: 0,
        liq_asym: 0,
        x1: Math.abs(e.z),
        x2: Math.max(0, e.zVol || 0),
        x7: 0,
      },
      key: `market:${e.symbol}:${dir}:${Math.round(e.ts / 60000)}`,
      title: `${base} ${dir} z=${e.z.toFixed(2)}`,
      body: `${base} $${fmtUsd(e.price)} · MAD-z ${e.z.toFixed(2)} via ${e.source}${
        e.degraded ? ' · DEGRADED feed' : ''
      }`,
      fields: [
        { label: 'Price', value: `$${fmtUsd(e.price)}` },
        { label: 'z', value: e.z.toFixed(2) },
        { label: 'zVol', value: Number.isFinite(e.zVol) ? e.zVol.toFixed(2) : 'n/a' },
        { label: 'relMad_bps', value: ((e.relMad || 0) * 10000).toFixed(2) },
        { label: 'Source', value: e.source },
      ],
    });
  }

  async handleVol(e) {
    const base = e.symbol.replace(/USDT$/, '');
    await this.emit({
      type: 'market',
      signal_type: 'market.volume_spike',
      source: e.source,
      coalesceKey: e.symbol,
      symbol: e.symbol,
      tier: 'public',
      degraded: e.degraded,
      entryPrice: e.price,
      features: { z: 0, zVol: Math.abs(e.zVol), funding_dev: 0, liq_asym: 0, x1: 0, x2: Math.abs(e.zVol), x7: 0 },
      key: `mktvol:${e.symbol}:${Math.round(e.ts / 60000)}`,
      title: `${base} volume spike zVol=${e.zVol.toFixed(2)}`,
      body: `Volume MAD-z ${e.zVol.toFixed(2)} on ${base} via ${e.source}`,
      fields: [
        { label: 'zVol', value: e.zVol.toFixed(2) },
        { label: 'Price', value: `$${fmtUsd(e.price)}` },
      ],
    });
  }
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

module.exports = { MarketSignal };
