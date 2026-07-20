/**
 * ChannelPlugin — drop-in base for delivery adapters.
 * Contract: name, enabled getter, start/stop, send(alert)->boolean, status()
 */
class ChannelPlugin {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.name = 'unnamed-channel';
  }

  get enabled() {
    return false;
  }

  async start() {}
  async stop() {}
  async send() {
    return false;
  }
  status() {
    return { enabled: this.enabled };
  }
}

module.exports = { ChannelPlugin };
