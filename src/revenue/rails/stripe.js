const Stripe = require('stripe');
const { PaymentRail } = require('./base');

class StripeRail extends PaymentRail {
  constructor(config, log) {
    super(config, log);
    this.name = 'stripe';
    this.stripe = null;
    this.stats = { checkouts: 0, webhooks: 0 };
  }

  get enabled() {
    return Boolean(this.config.stripe.secretKey);
  }

  async start() {
    if (!this.enabled) return;
    this.stripe = new Stripe(this.config.stripe.secretKey);
    this.log.info('Payment rail ready: stripe', {
      priceId: Boolean(this.config.stripe.priceId),
      monthlyUsd: this.config.stripe.monthlyUsd,
    });
  }

  async createCheckout({ email, telegramHandle } = {}) {
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
      // Soften restricted-business optics: data product framing
      custom_text: {
        submit: {
          message:
            'Market data alerts for informational/entertainment use only. Not financial advice.',
        },
      },
      metadata: {
        product: 'watchtower_premium_data',
        product_type: 'market_data_alerts',
        telegram_handle: telegramHandle || '',
      },
      subscription_data: {
        metadata: {
          product: 'watchtower_premium_data',
          telegram_handle: telegramHandle || '',
        },
      },
    };

    if (this.config.stripe.statementDescriptor) {
      params.payment_intent_data = undefined; // subscriptions use subscription statement descriptor via account
    }

    if (email) params.customer_email = email;

    if (this.config.stripe.priceId) {
      params.line_items = [{ price: this.config.stripe.priceId, quantity: 1 }];
    } else {
      params.line_items = [
        {
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(this.config.stripe.monthlyUsd * 100),
            recurring: { interval: 'month' },
            product_data: {
              name: this.config.stripe.productName || `${this.config.brand} Premium Data`,
              description:
                'Premium market-data alert feed (informational/entertainment). Not financial advice.',
            },
          },
          quantity: 1,
        },
      ];
    }

    const session = await this.stripe.checkout.sessions.create(params);
    this.stats.checkouts += 1;
    return { url: session.url, id: session.id, rail: 'stripe' };
  }

  async handleWebhook(rawBody, headers) {
    if (!this.stripe || !this.config.stripe.webhookSecret) {
      const err = new Error('Stripe webhook not configured');
      err.status = 503;
      throw err;
    }
    const signature = headers['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      this.config.stripe.webhookSecret
    );
    this.stats.webhooks += 1;
    this.log.info('Stripe webhook', { type: event.type, id: event.id });

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      return {
        type: 'checkout.session.completed',
        rail: 'stripe',
        email: session.customer_details?.email || session.customer_email,
        telegramHandle: session.metadata?.telegram_handle,
        inviteLink: this.config.telegram.inviteLink,
        sessionId: session.id,
      };
    }
    return { type: event.type, rail: 'stripe', handled: true };
  }

  status() {
    return { ...super.status(), ...this.stats };
  }
}

module.exports = { StripeRail };
