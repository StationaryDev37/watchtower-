/**
 * WatchtowerFramework — signals → bus → channels + revenue + store + watchdog.
 */

const { AlertBus } = require('./bus');
const { ChannelRegistry } = require('./channels');
const { SignalRegistry } = require('./signals');
const { RevenueEngine } = require('./revenue');
const { HttpSurface } = require('./http');
const { PriceFeed } = require('./feeds/priceFeed');
const { Store } = require('./store');
const { MemoryWatchdog } = require('./watchdog');

class WatchtowerFramework {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.store = new Store(config, log);
    this.priceFeed = new PriceFeed(config, log);
    this.bus = new AlertBus(config, log, { store: this.store });
    this.channels = new ChannelRegistry(config, log);
    this.signals = new SignalRegistry(config, log, this.bus, {
      priceFeed: this.priceFeed,
      store: this.store,
    });
    this.revenue = new RevenueEngine(config, log);
    this.watchdog = new MemoryWatchdog(config, log, {
      signals: this.signals,
      opsAlert: (text) => this.opsAlert(text),
    });
    this.http = new HttpSurface(config, log, {
      channels: this.channels,
      signals: this.signals,
      revenue: this.revenue,
      bus: this.bus,
      store: this.store,
      priceFeed: this.priceFeed,
      watchdog: this.watchdog,
      health: () => this.healthState(),
    });
    this.startedAt = Date.now();
  }

  async opsAlert(text) {
    const tg = this.channels.channels.find((c) => c.name === 'telegram');
    if (tg?.sendOps) return tg.sendOps(text);
    this.log.warn('OPS', { text });
  }

  healthState() {
    const priceLive = this.priceFeed.isLive();
    const hasAnyPrice = this.priceFeed.all().length > 0;
    const deliveryOk = Boolean(this.channels.listEnabled().length) || this.config.dryRun;
    const paymentsOk =
      this.revenue.rails.stripe.enabled ||
      this.revenue.rails.crypto.enabled ||
      this.config.dryRun;
    const critical = {
      priceSource: priceLive || hasAnyPrice || this.config.dryRun,
      delivery: deliveryOk,
      payments: paymentsOk,
    };
    // Critical for HTTP 200: price + delivery. Payments warn via payload, don't 503 the box.
    const ok = critical.priceSource && critical.delivery;
    return {
      ok,
      httpStatus: ok ? 200 : 503,
      critical,
      degraded: this.signals.anyDegraded() || (!priceLive && hasAnyPrice),
    };
  }

  async start() {
    this.log.info('Watchtower Framework starting', {
      architecture: 'single-source-v2',
      signals: this.config.signalsEnabled,
      channels: this.channels.listEnabled(),
      revenue: this.revenue.statusSummary(),
    });

    this.store.start();
    await this.priceFeed.start();
    await this.channels.start();
    await this.revenue.start();

    this.bus.onAlert(async (alert) => {
      const enriched = this.revenue.enrichAlert(alert);
      return this.channels.dispatch(enriched);
    });

    await this.signals.start();
    this.watchdog.start();
    this.http.start();

    this.log.info('Watchtower v2 live — edge signals + WSS prices + WAL history');
  }

  async stop() {
    this.log.info('Graceful shutdown — draining queues');
    this.watchdog.stop();
    this.http.stop();
    await this.bus.drain();
    await this.signals.stop();
    const tg = this.channels.channels.find((c) => c.name === 'telegram');
    if (tg?.stop) await tg.stop();
    await this.channels.stop();
    await this.priceFeed.stop();
    await this.revenue.stop();
    this.bus.stop();
    this.store.stop();
  }
}

module.exports = { WatchtowerFramework };
