const axios = require('axios');
const crypto = require('crypto');
const { PaymentRail } = require('./base');

/**
 * CryptoRail — fallback when Stripe freezes / restricts signal-adjacent merchants.
 *
 * Providers (CRYPTO_RAIL):
 *   nowpayments — invoice API (implemented)
 *   btcpay      — Greenfield invoice stub (needs BTCPay store URL)
 *   solana_pay  — returns a transfer URI / page for Phantom (stub → pay URL)
 *
 * Wire real keys via CRYPTO_RAIL_* env. Seam stays stable if you swap providers.
 */
class CryptoRail extends PaymentRail {
  constructor(config, log) {
    super(config, log);
    this.name = 'crypto';
    this.stats = { checkouts: 0, webhooks: 0 };
  }

  get enabled() {
    const c = this.config.cryptoRail;
    return Boolean(c.apiKey || c.payUrl || c.walletAddress);
  }

  async start() {
    if (!this.enabled) {
      this.log.info('Crypto payment rail idle — set CRYPTO_RAIL_* for Stripe fallback');
      return;
    }
    this.log.info('Payment rail ready: crypto', {
      provider: this.config.cryptoRail.provider,
      hasApiKey: Boolean(this.config.cryptoRail.apiKey),
      hasPayUrl: Boolean(this.config.cryptoRail.payUrl),
    });
  }

  async createCheckout({ email, telegramHandle } = {}) {
    if (!this.enabled) {
      const err = new Error('Crypto payment rail is not configured');
      err.status = 503;
      throw err;
    }

    const provider = this.config.cryptoRail.provider;
    const amount = this.config.stripe.monthlyUsd;
    const orderId = `wt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const success = this.config.stripe.successUrl;
    const meta = { email: email || '', telegramHandle: telegramHandle || '', orderId };

    let result;
    if (provider === 'nowpayments' && this.config.cryptoRail.apiKey) {
      result = await this.createNowPaymentsInvoice({ amount, orderId, success, meta });
    } else if (provider === 'btcpay' && this.config.cryptoRail.payUrl) {
      result = await this.createBtcpayInvoice({ amount, orderId, success, meta });
    } else if (provider === 'solana_pay') {
      result = this.createSolanaPayLink({ amount, orderId, meta });
    } else if (this.config.cryptoRail.payUrl) {
      // Generic hosted pay page (manual NOWPayments/BTCPay/etc. link)
      const url = new URL(this.config.cryptoRail.payUrl);
      url.searchParams.set('order', orderId);
      if (telegramHandle) url.searchParams.set('tg', telegramHandle);
      result = { url: url.toString(), id: orderId };
    } else {
      const err = new Error(
        `CRYPTO_RAIL=${provider} needs CRYPTO_RAIL_API_KEY or CRYPTO_RAIL_PAY_URL`
      );
      err.status = 503;
      throw err;
    }

    this.stats.checkouts += 1;
    this.log.info('Crypto checkout created', { provider, id: result.id });
    return { ...result, rail: 'crypto', provider };
  }

  async createNowPaymentsInvoice({ amount, orderId, success, meta }) {
    const { data } = await axios.post(
      'https://api.nowpayments.io/v1/invoice',
      {
        price_amount: amount,
        price_currency: 'usd',
        order_id: orderId,
        order_description: `${this.config.brand} Premium market-data alerts (not financial advice)`,
        ipn_callback_url: `${this.config.publicBaseUrl.replace(/\/$/, '')}/webhook/crypto`,
        success_url: success,
        cancel_url: this.config.stripe.cancelUrl,
        is_fixed_rate: false,
      },
      {
        headers: {
          'x-api-key': this.config.cryptoRail.apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    return {
      url: data.invoice_url,
      id: String(data.id || orderId),
      meta,
    };
  }

  async createBtcpayInvoice({ amount, orderId, success, meta }) {
    // Expect CRYPTO_RAIL_PAY_URL = https://btcpay.host/api/v1/stores/{storeId}/invoices
    // and CRYPTO_RAIL_API_KEY = Greenfield API key
    if (!this.config.cryptoRail.apiKey) {
      return {
        url: this.config.cryptoRail.payUrl,
        id: orderId,
        meta,
      };
    }
    const { data } = await axios.post(
      this.config.cryptoRail.payUrl,
      {
        amount,
        currency: 'USD',
        metadata: { orderId, ...meta },
        checkout: { redirectURL: success },
      },
      {
        headers: {
          Authorization: `token ${this.config.cryptoRail.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    return {
      url: data.checkoutLink || data.id,
      id: String(data.id || orderId),
      meta,
    };
  }

  createSolanaPayLink({ amount, orderId, meta }) {
    // Phantom-friendly: prefer a hosted pay page; else solana: transfer URI skeleton
    if (this.config.cryptoRail.payUrl) {
      const url = new URL(this.config.cryptoRail.payUrl);
      url.searchParams.set('order', orderId);
      url.searchParams.set('amount', String(amount));
      return { url: url.toString(), id: orderId, meta };
    }
    if (!this.config.cryptoRail.walletAddress) {
      const err = new Error('solana_pay needs CRYPTO_RAIL_WALLET or CRYPTO_RAIL_PAY_URL');
      err.status = 503;
      throw err;
    }
    // Amount in USDC would need mint + decimals — expose wallet for manual/hosted flow
    const url = `solana:${this.config.cryptoRail.walletAddress}?label=${encodeURIComponent(
      this.config.brand
    )}&message=${encodeURIComponent(`Premium ${orderId}`)}`;
    return { url, id: orderId, meta };
  }

  async handleWebhook(rawBody, headers) {
    this.stats.webhooks += 1;
    let payload = {};
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      payload = {};
    }

    // Optional HMAC for NOWPayments IPN
    if (this.config.cryptoRail.ipnSecret && headers['x-nowpayments-sig']) {
      const sorted = JSON.stringify(payload, Object.keys(payload).sort());
      const sig = crypto
        .createHmac('sha512', this.config.cryptoRail.ipnSecret)
        .update(sorted)
        .digest('hex');
      if (sig !== headers['x-nowpayments-sig']) {
        const err = new Error('Invalid crypto IPN signature');
        err.status = 401;
        throw err;
      }
    }

    const paid =
      payload.payment_status === 'finished' ||
      payload.payment_status === 'confirmed' ||
      payload.status === 'Settled' ||
      payload.type === 'InvoiceSettled';

    if (paid) {
      return {
        type: 'crypto.payment.completed',
        rail: 'crypto',
        provider: this.config.cryptoRail.provider,
        inviteLink: this.config.telegram.inviteLink,
        orderId: payload.order_id || payload.orderId || payload.id,
      };
    }

    return { type: 'crypto.payment.event', rail: 'crypto', handled: true, payload: payload.status };
  }

  status() {
    return {
      ...super.status(),
      provider: this.config.cryptoRail.provider,
      ...this.stats,
    };
  }
}

module.exports = { CryptoRail };
