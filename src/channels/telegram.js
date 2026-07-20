const axios = require('axios');
const { ChannelPlugin } = require('./base');
const { formatTelegram } = require('../templates/alerts');

/**
 * Telegram with priority lanes.
 * Premium jumps the queue; public batches. Respects ~30 msg/s global soft cap.
 */
class TelegramChannel extends ChannelPlugin {
  constructor(config, log) {
    super(config, log);
    this.name = 'telegram';
    this.stats = { free: 0, premium: 0, errors: 0, queued: 0 };
    this.premiumQ = [];
    this.publicQ = [];
    this.pumping = false;
    this.stopped = false;
    // Telegram global soft limit; stay conservative on shared bot tokens
    this.minIntervalMs = config.telegram?.minIntervalMs || 40;
  }

  get enabled() {
    return Boolean(this.config.telegram.botToken && this.config.telegram.freeChatId);
  }

  async start() {
    if (!this.enabled) {
      this.log.warn('Telegram disabled — set TELEGRAM_BOT_TOKEN + TELEGRAM_FREE_CHAT_ID');
      return;
    }
    this.stopped = false;
    this.log.info('Telegram channel ready (priority queue)', {
      free: Boolean(this.config.telegram.freeChatId),
      premium: Boolean(this.config.telegram.premiumChatId),
    });
  }

  async stop() {
    this.stopped = true;
    // Drain remaining with premium first
    while (this.premiumQ.length || this.publicQ.length) {
      await this.pumpOnce();
    }
  }

  status() {
    return {
      enabled: this.enabled,
      ...this.stats,
      queue: { premium: this.premiumQ.length, public: this.publicQ.length },
    };
  }

  async post(chatId, text) {
    await axios.post(
      `https://api.telegram.org/bot${this.config.telegram.botToken}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      },
      { timeout: 15000 }
    );
  }

  freeTeaser(alert) {
    if (alert.tier === 'public' || !alert.tier) return alert;
    return {
      ...alert,
      title: alert.type === 'whale' ? 'Whale activity detected' : `${alert.title} (preview)`,
      body:
        alert.type === 'whale'
          ? 'Large transfer spotted on-chain. Unlock Premium for wallets, size, and tx link.'
          : `${alert.body}\n\nFull signal + whale feed on Premium.`,
      fields: [],
      url: undefined,
    };
  }

  enqueue(job, priority) {
    this.stats.queued += 1;
    if (priority === 'premium') this.premiumQ.push(job);
    else this.publicQ.push(job);
    this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.stopped && (this.premiumQ.length || this.publicQ.length)) {
        await this.pumpOnce();
        await sleep(this.minIntervalMs);
      }
    } finally {
      this.pumping = false;
    }
  }

  async pumpOnce() {
    const job = this.premiumQ.shift() || this.publicQ.shift();
    if (!job) return;
    try {
      await this.post(job.chatId, job.text);
      if (job.lane === 'premium') this.stats.premium += 1;
      else this.stats.free += 1;
    } catch (err) {
      this.stats.errors += 1;
      this.log.error('Telegram send failed', { error: err.message, lane: job.lane });
    }
  }

  async send(alert) {
    if (!this.enabled) return false;
    let queued = false;

    if (alert.tier !== 'premium-only') {
      const payload = alert.tier === 'premium' ? this.freeTeaser(alert) : alert;
      this.enqueue(
        {
          chatId: this.config.telegram.freeChatId,
          text: formatTelegram(this.config, payload, { premium: false }),
          lane: 'public',
        },
        'public'
      );
      queued = true;
    }

    if (
      this.config.telegram.premiumChatId &&
      (alert.tier === 'premium' || alert.tier === 'premium-only')
    ) {
      this.enqueue(
        {
          chatId: this.config.telegram.premiumChatId,
          text: formatTelegram(this.config, alert, { premium: true }),
          lane: 'premium',
        },
        'premium'
      );
      queued = true;
    }

    return queued;
  }

  /** Ops alert — private chat or free channel, premium priority */
  async sendOps(text) {
    const chatId =
      this.config.telegram.opsChatId ||
      this.config.telegram.premiumChatId ||
      this.config.telegram.freeChatId;
    if (!this.enabled || !chatId) return false;
    this.enqueue({ chatId, text: `🛡 *OPS*\n${text}`, lane: 'premium' }, 'premium');
    return true;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { TelegramChannel };
