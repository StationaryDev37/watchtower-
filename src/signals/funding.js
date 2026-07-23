/**
 * Funding signal — packages FundingRouter divergence / flip into AlertBus envelopes.
 */
'use strict';

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
    this._div = (e) => {
      if (this.paused) return;
      this.stats.divergence += 1;
      const base = e.symbol.replace(/USDT$/, '');
      const d = e.deviation ?? e.maxD ?? 0;
      this.emit({
        type: 'funding',
        signal_type: 'funding.divergence',
        source: e.venue,
        coalesceKey: e.symbol,
        symbol: e.symbol,
        tier: e.tier || 'premium',
        lane: e.tier === 'premium_alpha' ? 'premium_alpha' : undefined,
        ts: e.ts || Date.now(),
        features: {
          x3: Math.abs(d),
          funding_dev: Math.abs(d),
          z: 0,
          zVol: 0,
          liq_asym: 0,
        },
        key: `funding:${e.symbol}:${e.venue}:${Math.round((e.ts || Date.now()) / 600000)}`,
        title: `${base} funding ${d > 0 ? 'rich' : 'cheap'} on ${e.venue}`,
        body: `${e.venue} d=${Number(d).toFixed(2)}σ vs median ${((e.consensus ?? e.rBar) * 100).toFixed(4)}%`,
        payload: e,
        fields: (e.venues || []).map((v) => ({
          label: v.venue,
          value: `${(v.rate * 100).toFixed(4)}%`,
        })),
      }).catch((err) => this.log.error('funding emit failed', { error: err.message }));
    };

    this._flip = (e) => {
      if (this.paused) return;
      this.stats.flips += 1;
      const base = e.symbol.replace(/USDT$/, '');
      const from = e.prior ?? e.from;
      const to = e.current ?? e.to;
      this.emit({
        type: 'funding',
        signal_type: 'funding.flip',
        source: e.venue || 'consensus',
        coalesceKey: e.symbol,
        symbol: e.symbol,
        tier: e.tier || 'premium',
        ts: e.ts || Date.now(),
        features: {
          x3: Math.abs(to - from) * 1e4,
          funding_dev: 1,
          z: 0,
          zVol: 0,
          liq_asym: 0,
        },
        key: `funding-flip:${e.symbol}:${e.venue || 'c'}`,
        title: `${base} funding flipped`,
        body: `${(from * 100).toFixed(4)}% → ${(to * 100).toFixed(4)}%`,
        payload: e,
        fields: [{ label: 'Venue', value: e.venue || 'consensus' }],
      }).catch((err) => this.log.error('funding flip emit failed', { error: err.message }));
    };

    // Prefer namespaced Commit B events; legacy aliases still emitted by router.
    this.fundingRouter.on('funding.divergence', this._div);
    this.fundingRouter.on('funding.flip', this._flip);
    this.log.info('Funding signal subscribed');
  }

  async stop() {
    if (!this.fundingRouter) return;
    this.fundingRouter.off('funding.divergence', this._div);
    this.fundingRouter.off('funding.flip', this._flip);
  }

  status() {
    return {
      running: Boolean(this.fundingRouter) && !this.paused,
      paused: this.paused,
      ...this.stats,
      feed: this.fundingRouter?.status?.(),
    };
  }

  metrics() {
    return this.fundingRouter?.snapshot?.() || {};
  }
}

module.exports = { FundingSignal };
