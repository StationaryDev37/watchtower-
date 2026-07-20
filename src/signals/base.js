/**
 * SignalPlugin — drop-in base for edge signals.
 *
 * v1 ships commodity adapters (market, whale) so the framework boots.
 * Money lives in *your* edge plugins: funding divergence, CEX flow,
 * cluster co-movement, new-pool snipes — drop a file here, no core edits.
 *
 * Contract:
 *   name: string
 *   async start()
 *   async stop()
 *   status(): object
 *   publish via this.bus.publish({ type, tier, key, title, body, fields?, url? })
 */
class SignalPlugin {
  constructor(config, log, bus) {
    this.config = config;
    this.log = log;
    this.bus = bus;
    this.name = 'unnamed-signal';
  }

  async start() {}
  async stop() {}
  status() {
    return { running: false };
  }

  /**
   * Helper: publish a structured alert. tier = public | premium | premium-only
   */
  async emit(alert) {
    return this.bus.publish({
      tier: 'public',
      ...alert,
      type: alert.type || this.name,
    });
  }
}

module.exports = { SignalPlugin };
