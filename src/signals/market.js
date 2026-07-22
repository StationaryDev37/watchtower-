const { SignalPlugin } = require('./base');

/**
 * Thin subscriber on PriceRouter spike events.
 * Latency: WSS ticks → MAD-z → AlertBus (not CoinGecko poll).
 */
class MarketSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'market';
    this.priceRouter = null;
    this.paused = false;
    this.stats = { spikes: 0 };
    this._onSpike = null;
    this._onVol = null;
  }

  async start() {
    if (!this.priceRouter) {
      this.log.warn('market signal: PriceRouter not injected');
      return;
    }
    this._onSpike = (ev) => {
      if (this.paused) return;
      this.handleSpike(ev).catch((err) =>
        this.log.error('spike handle failed', { error: err.message })
      );
    };
    this._onVol = (ev) => {
      if (this.paused) return;
      this.handleVol(ev).catch((err) =>
        this.log.error('vol spike handle failed', { error: err.message })
      );
    };
    this.priceRouter.on('spike', this._onSpike);
    this.priceRouter.on('volume-spike', this._onVol);
    this.log.info('Market signal subscribed to PriceRouter');
  }

  async stop() {
    if (this.priceRouter && this._onSpike) {
      this.priceRouter.off('spike', this._onSpike);
      this.priceRouter.off('volume-spike', this._onVol);
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  status() {
    return {
      running: Boolean(this.priceRouter) && !this.paused,
      paused: this.paused,
      spikes: this.stats.spikes,
      feed: this.priceRouter?.status?.(),
    };
  }

  async handleSpike(ev) {
    this.stats.spikes += 1;
    const dir = ev.z >= 0 ? 'UP' : 'DOWN';
    const base = ev.symbol.replace(/USDT$/, '');
    await this.emit({
      type: 'market',
      source: ev.source,
      coalesceKey: `market:${ev.symbol}`,
      symbol: ev.symbol,
      tier: ev.tier,
      degraded: ev.degraded,
      entryPrice: ev.price,
      features: {
        z: Math.abs(ev.z),
        zVol: Math.abs(ev.zVol || 0),
        funding_dev: 0,
        liq_asym: 0,
      },
      key: `market:${ev.symbol}:${dir}:${Math.round(ev.ts / 60000)}`,
      title: `${base} ${dir} z=${ev.z.toFixed(2)}`,
      body: `${base} $${fmtUsd(ev.price)} · MAD-z ${ev.z.toFixed(2)} via ${ev.source}${
        ev.degraded ? ' · DEGRADED feed' : ''
      }`,
      fields: [
        { label: 'Price', value: `$${fmtUsd(ev.price)}` },
        { label: 'z', value: ev.z.toFixed(2) },
        { label: 'zVol', value: Number.isFinite(ev.zVol) ? ev.zVol.toFixed(2) : 'n/a' },
        { label: 'Source', value: ev.source },
      ],
    });
  }

  async handleVol(ev) {
    const base = ev.symbol.replace(/USDT$/, '');
    await this.emit({
      type: 'market',
      source: ev.source,
      coalesceKey: `market:${ev.symbol}`,
      symbol: ev.symbol,
      tier: 'public',
      degraded: ev.degraded,
      entryPrice: ev.price,
      features: { z: 0, zVol: Math.abs(ev.zVol), funding_dev: 0, liq_asym: 0 },
      key: `mktvol:${ev.symbol}:${Math.round(ev.ts / 60000)}`,
      title: `${base} volume spike zVol=${ev.zVol.toFixed(2)}`,
      body: `Volume MAD-z ${ev.zVol.toFixed(2)} on ${base} via ${ev.source}`,
      fields: [
        { label: 'zVol', value: ev.zVol.toFixed(2) },
        { label: 'Price', value: `$${fmtUsd(ev.price)}` },
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
