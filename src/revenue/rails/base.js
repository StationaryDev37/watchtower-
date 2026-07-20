/**
 * PaymentRail — adapter seam.
 * Stripe is primary (card subs). Crypto rails exist because Stripe
 * regularly freezes "signal / investment-adjacent" merchants.
 */
class PaymentRail {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.name = 'base';
  }

  get enabled() {
    return false;
  }

  async start() {}
  async stop() {}

  /** @returns {{ url: string, id: string, rail: string }} */
  async createCheckout(_opts) {
    const err = new Error(`${this.name} checkout not implemented`);
    err.status = 501;
    throw err;
  }

  /** Verify + parse inbound webhook/IPN. */
  async handleWebhook(_raw, _headers) {
    return { handled: false };
  }

  status() {
    return { name: this.name, enabled: this.enabled };
  }
}

module.exports = { PaymentRail };
