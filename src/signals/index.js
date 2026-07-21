const path = require('path');
const { loadPlugins } = require('../plugins');

/**
 * Auto-loads signal plugins. Injects shared deps (priceFeed) post-construct.
 */
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
        'SolanaWhaleSignal',
        'SignalPlugin',
        'default',
      ],
      config,
      log,
      extraArgs: [bus],
    });

    for (const s of all) {
      if (deps.priceFeed) s.priceFeed = deps.priceFeed;
      if (deps.store) s.store = deps.store;
    }

    this.signals = all.filter((s) => enabled.has(s.name));
    const skipped = all.filter((s) => !enabled.has(s.name)).map((s) => s.name);
    if (skipped.length) {
      this.log.info('Signals present but not enabled', { skipped, enabled: [...enabled] });
    }
    if (!this.signals.length) {
      this.log.warn('No signals enabled — set SIGNALS_ENABLED=market,funding,liquidations');
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

  /** Any enabled signal marked degraded? */
  anyDegraded() {
    return this.signals.some((s) => s.status()?.degraded);
  }
}

module.exports = { SignalRegistry };
