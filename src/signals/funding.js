const { SignalPlugin } = require('./base');

class FundingSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'funding';
    this.fundingRouter = null;
    this.stats = { divergence: 0, flips: 0 };
  }

  async start() {
    if (!this.fundingRouter) {
      this.log.warn('funding signal: FundingRouter not injected');
      return;
    }
    this._div = (ev) => {
      if (this.paused) return;
      this.stats.divergence += 1;
      const base = ev.symbol.replace(/USDT$/, '');
      this.emit({
        type: 'funding',
        tier: 'premium',
        coalesceKey: `funding:${ev.symbol}`,
        symbol: ev.symbol,
        entryPrice: null,
        features: {
          z: 0,
          zVol: 0,
          funding_dev: Math.abs(ev.maxD),
          liq_asym: 0,
        },
        key: `funding:${ev.symbol}:${ev.venue}:${Math.round(Date.now() / 600000)}`,
        title: `${base} funding ${ev.maxD > 0 ? 'rich' : 'cheap'} on ${ev.venue}`,
        body: `${ev.venue} d=${ev.maxD.toFixed(2)}σ vs median ${(ev.rBar * 100).toFixed(4)}%`,
        fields: ev.venues.map((v) => ({
          label: v.venue,
          value: `${(v.rate * 100).toFixed(4)}%`,
        })),
      }).catch((err) => this.log.error('funding emit failed', { error: err.message }));
    };
    this._flip = (ev) => {
      if (this.paused) return;
      this.stats.flips += 1;
      const base = ev.symbol.replace(/USDT$/, '');
      this.emit({
        type: 'funding',
        tier: 'premium',
        coalesceKey: `funding-flip:${ev.symbol}`,
        symbol: ev.symbol,
        features: { z: 0, zVol: 0, funding_dev: 1, liq_asym: 0 },
        key: `funding-flip:${ev.symbol}:${ev.venue}`,
        title: `${base} funding flipped on ${ev.venue}`,
        body: `${(ev.from * 100).toFixed(4)}% → ${(ev.to * 100).toFixed(4)}%`,
        fields: [{ label: 'Venue', value: ev.venue }],
      }).catch((err) => this.log.error('funding flip emit failed', { error: err.message }));
    };
    this.fundingRouter.on('divergence', this._div);
    this.fundingRouter.on('flip', this._flip);
    this.log.info('Funding signal subscribed');
  }

  async stop() {
    if (this.fundingRouter) {
      this.fundingRouter.off('divergence', this._div);
      this.fundingRouter.off('flip', this._flip);
    }
  }

  status() {
    return {
      running: Boolean(this.fundingRouter) && !this.paused,
      paused: this.paused,
      ...this.stats,
      feed: this.fundingRouter?.status?.(),
    };
  }
}

module.exports = { FundingSignal };
