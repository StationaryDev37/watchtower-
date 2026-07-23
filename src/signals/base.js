/**
 * SignalPlugin — drop-in base.
 * pause()/resume() used by Watchdog shedding.
 */
class SignalPlugin {
  constructor(config, log, bus) {
    this.config = config;
    this.log = log;
    this.bus = bus;
    this.name = 'unnamed-signal';
    this.paused = false;
    this.priceRouter = null;
    this.store = null;
    this.history = null;
  }

  async start() {}
  async stop() {}
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  status() {
    return { running: false, paused: this.paused };
  }

  async emit(alert) {
    if (this.paused) return { sent: false, reason: 'paused' };
    return this.bus.publish({
      tier: 'public',
      ...alert,
      type: alert.type || this.name,
    });
  }
}

module.exports = { SignalPlugin };
