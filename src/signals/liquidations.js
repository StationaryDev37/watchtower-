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
    this._on = (ev) => {
      if (this.paused) return;
      this.stats.cascades += 1;
      const base = ev.symbol.replace(/USDT$/, '');
      const dir = ev.side === 'long' ? 'LONGS' : 'SHORTS';
      this.emit({
        type: 'liquidations',
        tier: ev.tier === 'premium_alpha' ? 'premium' : ev.tier,
        lane: ev.tier === 'premium_alpha' ? 'premium_alpha' : 'premium',
        coalesceKey: `liq:${ev.symbol}`,
        symbol: ev.symbol,
        features: {
          z: 0,
          zVol: 0,
          funding_dev: 0,
          liq_asym: ev.asym,
        },
        key: `liq:${ev.symbol}:${ev.side}:${Math.round(ev.ts / 30000)}`,
        title: `${base} ${dir} cascade $${fmtUsd(ev.L)}`,
        body: `Decay-accumulator ≥$${fmtUsd(this.config.liquidations.cascadeUsd)} (τ=${this.config.liquidations.tauSec}s) via ${ev.venue}`,
        fields: [
          { label: 'L', value: `$${fmtUsd(ev.L)}` },
          { label: 'Opposite', value: `$${fmtUsd(ev.opp)}` },
          { label: 'Asym', value: ev.asym.toFixed(2) },
        ],
      }).catch((err) => this.log.error('liq emit failed', { error: err.message }));
    };
    this.liquidationsFeed.on('cascade', this._on);
    this.log.info('Liquidations signal subscribed');
  }

  async stop() {
    if (this.liquidationsFeed && this._on) {
      this.liquidationsFeed.off('cascade', this._on);
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
}

function fmtUsd(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

module.exports = { LiquidationsSignal };
