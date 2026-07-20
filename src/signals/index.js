const path = require('path');
const { loadPlugins } = require('../plugins');

/**
 * Auto-loads every *.js in this folder except index/base/_*.
 * Enabled set comes from SIGNALS_ENABLED (comma list of plugin `name`s).
 */
class SignalRegistry {
  constructor(config, log, bus) {
    this.config = config;
    this.log = log;
    this.bus = bus;
    const enabled = new Set(config.signalsEnabled);
    const all = loadPlugins(path.join(__dirname), {
      exportNames: ['MarketSignal', 'WhaleSignal', 'SignalPlugin', 'default'],
      config,
      log,
      extraArgs: [bus],
    });
    this.signals = all.filter((s) => enabled.has(s.name));
    const skipped = all.filter((s) => !enabled.has(s.name)).map((s) => s.name);
    if (skipped.length) {
      this.log.info('Signals present but not enabled', { skipped, enabled: [...enabled] });
    }
    if (!this.signals.length) {
      this.log.warn('No signals enabled — set SIGNALS_ENABLED=market (or whale, …)');
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
}

module.exports = { SignalRegistry };
