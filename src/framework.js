/**
 * WatchtowerFramework — PR #2 data plane (Commit A):
 * store + PriceRouter + market on WSS MAD-z.
 */

const { AlertBus } = require('./bus');
const { ChannelRegistry } = require('./channels');
const { SignalRegistry } = require('./signals');
const { RevenueEngine } = require('./revenue');
const { HttpSurface } = require('./http');
const { Db } = require('./store/db');
const { History } = require('./store/history');
const { PriceRouter } = require('./sources/PriceRouter');

class WatchtowerFramework {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.db = new Db(config, log);
    this.history = new History(null, log); // rebound after db.start
    this.priceRouter = new PriceRouter(config, log);
    this.bus = new AlertBus(config, log, { history: null });
    this.channels = new ChannelRegistry(config, log);
    this.signals = null;
    this.revenue = new RevenueEngine(config, log);
    this.http = null;
    this.startedAt = Date.now();
  }

  async start() {
    this.db.start();
    this.history = new History(this.db, this.log);
    this.history.start();
    this.bus.history = this.history;

    this.signals = new SignalRegistry(this.config, this.log, this.bus, {
      priceRouter: this.priceRouter,
      history: this.history,
      store: this.db,
    });

    this.http = new HttpSurface(this.config, this.log, {
      channels: this.channels,
      signals: this.signals,
      revenue: this.revenue,
      bus: this.bus,
      history: this.history,
      priceRouter: this.priceRouter,
      health: () => this.healthState(),
    });

    this.log.info('Watchtower Framework starting', {
      architecture: 'pr2-commit-a',
      signals: this.config.signalsEnabled,
    });

    await this.priceRouter.start();
    await this.channels.start();
    await this.revenue.start();

    this.bus.onAlert(async (alert) => {
      const enriched = this.revenue.enrichAlert(alert);
      return this.channels.dispatch(enriched);
    });

    await this.signals.start();
    this.http.start();
    this.log.info('Watchtower live — PriceRouter MAD-z data plane');
  }

  healthState() {
    const live = this.priceRouter.isLive();
    const delivery = this.channels.listEnabled().length > 0 || this.config.dryRun;
    const ok = (live || this.priceRouter.prices.size > 0 || this.config.dryRun) && delivery;
    return {
      ok,
      httpStatus: ok ? 200 : 503,
      status: ok ? (this.priceRouter.degraded ? 'degraded' : 'healthy') : 'unhealthy',
      critical: {
        priceRouter: live || this.priceRouter.prices.size > 0 || this.config.dryRun,
        delivery,
      },
    };
  }

  async stop() {
    this.http?.stop();
    await this.signals?.stop();
    await this.channels.stop();
    await this.priceRouter.stop();
    await this.revenue.stop();
    this.bus.stop();
    this.db.stop();
  }
}

module.exports = { WatchtowerFramework };
