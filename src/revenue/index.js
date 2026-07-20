const { StripeRail } = require('./rails/stripe');
const { CryptoRail } = require('./rails/crypto');

/**
 * RevenueEngine — payment rails + affiliate enrichment.
 * Primary: Stripe. Fallback: crypto (NOWPayments / BTCPay / Solana Pay seam).
 */
class RevenueEngine {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.alertCount = 0;
    this.stats = { affiliatesAttached: 0, upgradesAttached: 0 };
    this.rails = {
      stripe: new StripeRail(config, log),
      crypto: new CryptoRail(config, log),
    };
  }

  async start() {
    await this.rails.stripe.start();
    await this.rails.crypto.start();
    this.log.info('Revenue rails', this.statusSummary());
  }

  async stop() {
    await this.rails.stripe.stop();
    await this.rails.crypto.stop();
  }

  primaryRail() {
    return this.rails[this.config.payments.primary] || this.rails.stripe;
  }

  fallbackRail() {
    return this.rails[this.config.payments.fallback] || this.rails.crypto;
  }

  statusSummary() {
    return {
      primary: this.config.payments.primary,
      fallback: this.config.payments.fallback,
      stripe: this.rails.stripe.enabled,
      crypto: this.rails.crypto.enabled,
      affiliate: this.config.affiliate.enabled && Boolean(this.config.affiliate.exchangeUrl),
      premiumInvite: Boolean(this.config.telegram.inviteLink),
    };
  }

  getStats() {
    return {
      ...this.stats,
      ...this.statusSummary(),
      rails: {
        stripe: this.rails.stripe.status(),
        crypto: this.rails.crypto.status(),
      },
    };
  }

  upgradeUrl() {
    return `${this.config.publicBaseUrl.replace(/\/$/, '')}/upgrade`;
  }

  enrichAlert(alert) {
    this.alertCount += 1;
    const monetization = {
      upgradeUrl: this.upgradeUrl(),
      tweetUpgradeUrl: this.config.growth.tweetUpgradeUrl || this.upgradeUrl(),
      disclaimer: this.config.legal.shortDisclaimer,
    };

    if (
      this.config.affiliate.enabled &&
      this.config.affiliate.exchangeUrl &&
      this.alertCount % Math.max(1, this.config.affiliate.ctaEveryN) === 0
    ) {
      monetization.affiliateUrl = this.config.affiliate.exchangeUrl;
      monetization.affiliateLabel = this.config.affiliate.exchangeLabel || 'Trade now';
      this.stats.affiliatesAttached += 1;
    }

    this.stats.upgradesAttached += 1;
    return { ...alert, monetization };
  }

  async createCheckoutSession(opts = {}) {
    const prefer = (opts.rail || this.config.payments.primary || 'stripe').toLowerCase();
    const order = prefer === 'crypto'
      ? [this.rails.crypto, this.rails.stripe]
      : [this.primaryRail(), this.fallbackRail()];

    let lastErr;
    for (const rail of order) {
      if (!rail?.enabled) continue;
      try {
        return await rail.createCheckout(opts);
      } catch (err) {
        lastErr = err;
        this.log.warn(`${rail.name} checkout failed, trying next rail`, { error: err.message });
      }
    }
    const err = lastErr || new Error('No payment rail available');
    err.status = err.status || 503;
    throw err;
  }

  async handleStripeWebhook(raw, headers) {
    return this.rails.stripe.handleWebhook(raw, headers);
  }

  async handleCryptoWebhook(raw, headers) {
    return this.rails.crypto.handleWebhook(raw, headers);
  }

  /** @deprecated use handleStripeWebhook — kept for older call sites */
  constructWebhookEvent() {
    throw new Error('Use handleStripeWebhook(raw, headers)');
  }

  async handleWebhook(event) {
    return event;
  }
}

module.exports = { RevenueEngine };
