/**
 * WatchtowerFramework — single orchestrator for signals → channels → revenue.
 * Adding a signal, channel, or monetization path is a plugin, not a rewrite.
 */

const { AlertBus } = require('./bus');
const { ChannelRegistry } = require('./channels');
const { SignalRegistry } = require('./signals');
const { RevenueEngine } = require('./revenue');
const { HttpSurface } = require('./http');

class WatchtowerFramework {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.bus = new AlertBus(config, log);
    this.channels = new ChannelRegistry(config, log);
    this.signals = new SignalRegistry(config, log, this.bus);
    this.revenue = new RevenueEngine(config, log);
    this.http = new HttpSurface(config, log, {
      channels: this.channels,
      signals: this.signals,
      revenue: this.revenue,
      bus: this.bus,
    });
  }

  async start() {
    this.log.info('Watchtower Framework starting', {
      architecture: 'single-source',
      signals: this.config.signalsEnabled,
      channels: this.channels.listEnabled(),
      revenue: this.revenue.statusSummary(),
    });

    await this.channels.start();
    await this.revenue.start();

    // Every alert: enrich with monetization → fan out to channels
    this.bus.onAlert(async (alert) => {
      const enriched = this.revenue.enrichAlert(alert);
      return this.channels.dispatch(enriched);
    });

    await this.signals.start();
    this.http.start();

    this.log.info('Watchtower live — free alerts now, paid upgrades from day 1');
  }

  async stop() {
    this.http.stop();
    await this.signals.stop();
    await this.channels.stop();
    await this.revenue.stop();
    this.bus.stop();
  }
}

module.exports = { WatchtowerFramework };
