const Stripe = require('stripe');

/**
 * RevenueEngine — day-1 monetization in the same process as alerts.
 * Paths: Stripe Checkout (premium Telegram) + affiliate CTAs on every alert.
 */
class RevenueEngine {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.stripe = null;
    this.alertCount = 0;
    this.stats = {
      checkouts: 0,
      webhookEvents: 0,
      affiliatesAttached: 0,
      upgradesAttached: 0,
    };
  }

  async start() {
    if (this.config.stripe.secretKey) {
      this.stripe = new Stripe(this.config.stripe.secretKey);
      this.log.info('Stripe revenue path ready', {
        priceId: Boolean(this.config.stripe.priceId),
        monthlyUsd: this.config.stripe.monthlyUsd,
      });
    } else {
      this.log.warn('STRIPE_SECRET_KEY missing — /upgrade checkout disabled until set');
    }
  }

  async stop() {}

  statusSummary() {
    return {
      stripe: Boolean(this.config.stripe.secretKey),
      affiliate: this.config.affiliate.enabled && Boolean(this.config.affiliate.exchangeUrl),
      premiumInvite: Boolean(this.config.telegram.inviteLink),
    };
  }

  getStats() {
    return { ...this.stats, ...this.statusSummary() };
  }

  upgradeUrl() {
    return `${this.config.publicBaseUrl.replace(/\/$/, '')}/upgrade`;
  }

  enrichAlert(alert) {
    this.alertCount += 1;
    const monetization = {
      upgradeUrl: this.upgradeUrl(),
      tweetUpgradeUrl: this.config.growth.tweetUpgradeUrl || this.upgradeUrl(),
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

  async createCheckoutSession({ email, telegramHandle } = {}) {
    if (!this.stripe) {
      const err = new Error('Stripe is not configured');
      err.status = 503;
      throw err;
    }

    const params = {
      mode: 'subscription',
      success_url: this.config.stripe.successUrl,
      cancel_url: this.config.stripe.cancelUrl,
      allow_promotion_codes: true,
      metadata: {
        product: 'watchtower_premium',
        telegram_handle: telegramHandle || '',
      },
      subscription_data: {
        metadata: {
          product: 'watchtower_premium',
          telegram_handle: telegramHandle || '',
        },
      },
    };

    if (email) params.customer_email = email;

    if (this.config.stripe.priceId) {
      params.line_items = [{ price: this.config.stripe.priceId, quantity: 1 }];
    } else {
      // Zero-config launch: create price inline so revenue works before dashboard setup
      params.line_items = [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(this.config.stripe.monthlyUsd * 100),
            recurring: { interval: 'month' },
            product_data: {
              name: this.config.stripe.productName || `${this.config.brand} Premium`,
              description: 'Premium whale + early volatility alerts via private Telegram',
            },
          },
          quantity: 1,
        },
      ];
    }

    const session = await this.stripe.checkout.sessions.create(params);
    this.stats.checkouts += 1;
    this.log.info('Checkout session created', { id: session.id });
    return session;
  }

  constructWebhookEvent(rawBody, signature) {
    if (!this.stripe || !this.config.stripe.webhookSecret) {
      const err = new Error('Stripe webhook not configured');
      err.status = 503;
      throw err;
    }
    return this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.config.stripe.webhookSecret
    );
  }

  async handleWebhook(event) {
    this.stats.webhookEvents += 1;
    this.log.info('Stripe webhook', { type: event.type, id: event.id });

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      return {
        type: 'checkout.session.completed',
        email: session.customer_details?.email || session.customer_email,
        telegramHandle: session.metadata?.telegram_handle,
        inviteLink: this.config.telegram.inviteLink,
        sessionId: session.id,
      };
    }

    return { type: event.type, handled: true };
  }
}

module.exports = { RevenueEngine };
