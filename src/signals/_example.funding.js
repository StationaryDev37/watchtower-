/**
 * EXAMPLE EDGE SIGNAL — copy to funding.js (remove leading _) and enable via
 * SIGNALS_ENABLED=market,funding
 *
 * Commodity market/whale plugins boot the framework. Retention (and ARPU)
 * come from edges like funding-rate divergence, CEX flow, cluster co-movement.
 * This stub shows the contract without shipping fake alpha.
 */

const { SignalPlugin } = require('./base');

class FundingDivergenceSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'funding';
  }

  async start() {
    this.log.info(
      'FundingDivergenceSignal stub — implement exchange funding fetch here, then this.emit({...})'
    );
  }

  status() {
    return { running: false, stub: true };
  }
}

module.exports = { FundingDivergenceSignal };
