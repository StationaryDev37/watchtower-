/**
 * WatchtowerFramework — PR #2 Commit B: funding + liquidations + AlertBus lanes.
 */

const { AlertBus } = require('./bus/AlertBus');
const { ChannelRegistry } = require('./channels');
const { SignalRegistry } = require('./signals');
const { RevenueEngine } = require('./revenue');
const { HttpSurface } = require('./http');
const { Db } = require('./store/db');
const { History } = require('./store/history');
const { PriceRouter } = require('./sources/PriceRouter');
const { FundingRouter } = require('./sources/FundingRouter');
const { LiquidationsFeed } = require('./sources/LiquidationsFeed');

class WatchtowerFramework {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.db = new Db(config, log);
    this.history = null;
    this.priceRouter = new PriceRouter(config, log);
    this.fundingRouter = new FundingRouter(config, log);
    this.liquidationsFeed = new LiquidationsFeed(config, log);
    this.bus = new AlertBus(config, log);
    this.channels = new ChannelRegistry(config, log);
    this.signals = null;
    this.revenue = new RevenueEngine(config, log);
    this.http = null;
    this.startedAt = Date.now();
  }

  async start() {
    this.db.start();
    this.history = new History(this.db, this.log).start();
    this.bus.history = this.history;

    this.signals = new SignalRegistry(this.config, this.log, this.bus, {
      priceRouter: this.priceRouter,
      fundingRouter: this.fundingRouter,
      liquidationsFeed: this.liquidationsFeed,
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
      fundingRouter: this.fundingRouter,
      liquidationsFeed: this.liquidationsFeed,
      health: () => this.healthState(),
    });

    this.log.info('Watchtower Framework starting', {
      architecture: 'pr2-commit-b',
      signals: this.config.signalsEnabled,
    });

    await this.priceRouter.start();
    await this.fundingRouter.start();
    await this.liquidationsFeed.start();
    await this.channels.start();
    await this.revenue.start();

    this.bus.onAlert(async (alert) => {
      const enriched = this.revenue.enrichAlert(alert);
      return this.channels.dispatch(enriched);
    });

    await this.signals.start();
    this.http.start();
    this.log.info('Watchtower live — funding + liquidations + coalesce/lanes');
  }

  healthState() {
    const live = this.priceRouter.isLive() || this.priceRouter.prices.size > 0;
    const delivery = this.channels.listEnabled().length > 0 || this.config.dryRun;
    const ok = (live || this.config.dryRun) && delivery;
    return {
      ok,
      httpStatus: ok ? 200 : 503,
      status: ok ? (this.priceRouter.degraded ? 'degraded' : 'healthy') : 'unhealthy',
      critical: {
        priceRouter: live || this.config.dryRun,
        delivery,
      },
      deps: {
        priceRouter: this.priceRouter.status(),
        fundingRouter: this.fundingRouter.status(),
        liquidationsFeed: this.liquidationsFeed.status(),
      },
    };
  }

  async stop() {
    this.log.info('Graceful shutdown — draining AlertBus');
    this.http?.stop();
    await this.bus.drain();
    await this.signals?.stop();
    await this.channels.stop();
    await this.liquidationsFeed.stop();
    await this.fundingRouter.stop();
    await this.priceRouter.stop();
    await this.revenue.stop();
    this.bus.stop();
    this.db.stop();
  }
}

module.exports = { WatchtowerFramework };
