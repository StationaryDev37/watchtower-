const path = require('path');
const { loadPlugins } = require('../plugins');

class SignalRegistry {
  constructor(config, log, bus, deps = {}) {
    this.config = config;
    this.log = log;
    this.bus = bus;
    this.deps = deps;
    const enabled = new Set(config.signalsEnabled);
    const all = loadPlugins(path.join(__dirname), {
      exportNames: [
        'MarketSignal',
        'WhaleSignal',
        'FundingSignal',
        'LiquidationsSignal',
        'SignalPlugin',
        'default',
      ],
      config,
      log,
      extraArgs: [bus],
    });
    for (const s of all) {
      if (deps.priceRouter) s.priceRouter = deps.priceRouter;
      if (deps.fundingRouter) s.fundingRouter = deps.fundingRouter;
      if (deps.liquidationsFeed) s.liquidationsFeed = deps.liquidationsFeed;
      if (deps.history) s.history = deps.history;
      if (deps.store) s.store = deps.store;
    }
    this.signals = all.filter((s) => enabled.has(s.name));
    const skipped = all.filter((s) => !enabled.has(s.name)).map((s) => s.name);
    if (skipped.length) {
      this.log.info('Signals present but not enabled', { skipped, enabled: [...enabled] });
    }
  }

  async start() {
    for (const s of this.signals) await s.start();
  }

  async stop() {
    for (const s of this.signals) await s.stop();
  }

  status() {
    return Object.fromEntries(this.signals.map((s) => [s.name, s.status()]));
  }

  ingressCount60s() {
    // filled by bus counters in later commits; placeholder map by name
    return Object.fromEntries(this.signals.map((s) => [s.name, s.stats?.spikes || 0]));
  }
}

module.exports = { SignalRegistry };
