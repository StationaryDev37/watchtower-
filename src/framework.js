/**
 * WatchtowerFramework — PR #2 Commit C: ops + conviction scorer.
 */

const { AlertBus } = require('./bus/AlertBus');
const { ConvictionScorer } = require('./bus/ConvictionScorer');
const { ChannelRegistry } = require('./channels');
const { SignalRegistry } = require('./signals');
const { RevenueEngine } = require('./revenue');
const { HttpSurface } = require('./http');
const { Db } = require('./store/db');
const { History } = require('./store/history');
const { PriceRouter } = require('./sources/PriceRouter');
const { FundingRouter } = require('./sources/FundingRouter');
const { LiquidationsFeed } = require('./sources/LiquidationsFeed');
const { CircuitBreaker } = require('./ops/CircuitBreaker');
const { Watchdog } = require('./ops/Watchdog');
const { Health } = require('./ops/Health');

class WatchtowerFramework {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.breakers = {
      binance: new CircuitBreaker('binance', log),
      bybit: new CircuitBreaker('bybit', log),
      okx: new CircuitBreaker('okx', log),
      coingecko: new CircuitBreaker('coingecko', log),
      telegram: new CircuitBreaker('telegram', log),
      stripe: new CircuitBreaker('stripe', log),
    };
    this.db = new Db(config, log);
    this.history = null;
    this.scorer = null;
    this.priceRouter = new PriceRouter(config, log, { breakers: this.breakers });
    this.fundingRouter = new FundingRouter(config, log, { breakers: this.breakers });
    this.liquidationsFeed = new LiquidationsFeed(config, log, { breakers: this.breakers });
    this.bus = new AlertBus(config, log);
    this.channels = new ChannelRegistry(config, log);
    for (const ch of this.channels.channels) ch.bus = this.bus;
    this.signals = null;
    this.watchdog = null;
    this.health = null;
    this.revenue = new RevenueEngine(config, log);
    this.http = null;
    this.startedAt = Date.now();
  }

  async start() {
    this.db.start();
    this.history = new History(this.db, this.log).start();
    this.scorer = new ConvictionScorer(this.config, this.log, { history: this.history });
    this.scorer.start();
    this.bus.history = this.history;
    this.bus.scorer = this.scorer;

    this.signals = new SignalRegistry(this.config, this.log, this.bus, {
      priceRouter: this.priceRouter,
      fundingRouter: this.fundingRouter,
      liquidationsFeed: this.liquidationsFeed,
      history: this.history,
      store: this.db,
    });

    this.health = new Health(this.config, this.log, {
      breakers: this.breakers,
      priceRouter: this.priceRouter,
    });

    this.watchdog = new Watchdog(this.config, this.log, {
      signals: this.signals,
      bus: this.bus,
      opsAlert: (t) => this.opsAlert(t),
      onFatal: () => {
        this.log.error('FATAL RSS — exiting for PM2 reload');
        setTimeout(() => process.exit(1), 500);
      },
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
      watchdog: this.watchdog,
      health: () => this.health.evaluate(),
    });

    this.log.info('Watchtower Framework starting', {
      architecture: 'pr2-commit-c',
      signals: this.config.signalsEnabled,
    });

    await this.priceRouter.start();
    await this.fundingRouter.start();
    await this.liquidationsFeed.start();
    await this.channels.start();
    await this.revenue.start();

    // Commit B: channels subscribe to deliver; signals still publish/emit('alert').
    const fanout = async (alert) => {
      const enriched = this.revenue.enrichAlert(alert);
      return this.channels.dispatch(enriched);
    };
    this.bus.onAlert(fanout);
    this.bus.on('deliver', (env) => {
      // EventEmitter path (tests / future plugins). onAlert handlers already cover prod fanout;
      // only dual-fire when no handlers registered.
      if (!this.bus.handlers.length) {
        fanout(env).catch((err) => this.log.error('deliver fanout failed', { error: err.message }));
      }
    });

    await this.signals.start();
    this.watchdog.start();
    this.http.start();
    this.log.info('Watchtower live — Commit B bus + funding/liq edge online');
  }

  async opsAlert(text) {
    const tg = this.channels.channels.find((c) => c.name === 'telegram');
    if (tg?.sendOps) return tg.sendOps(text);
    this.log.warn('OPS', { text });
  }

  async stop() {
    this.log.info('Graceful shutdown — draining AlertBus');
    this.watchdog?.stop();
    this.http?.stop();
    await this.bus.drain();
    await this.signals?.stop();
    await this.channels.stop();
    await this.liquidationsFeed.stop();
    await this.fundingRouter.stop();
    await this.priceRouter.stop();
    this.scorer?.stop();
    await this.revenue.stop();
    this.bus.stop();
    this.db.stop();
  }
}

module.exports = { WatchtowerFramework };
