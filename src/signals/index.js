const { MarketSignal } = require('./market');
const { WhaleSignal } = require('./whale');

class SignalRegistry {
  constructor(config, log, bus) {
    this.config = config;
    this.log = log;
    this.bus = bus;
    const enabled = new Set(config.signalsEnabled);
    this.signals = [];
    if (enabled.has('market')) this.signals.push(new MarketSignal(config, log, bus));
    if (enabled.has('whale')) this.signals.push(new WhaleSignal(config, log, bus));
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
