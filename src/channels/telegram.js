const { ChannelPlugin } = require('./base');
const { formatTelegram } = require('../templates/alerts');
const axios = require('axios');

class TelegramChannel extends ChannelPlugin {
  constructor(config, log) {
    super(config, log);
    this.name = 'telegram';
    this.stats = { free: 0, premium: 0, errors: 0 };
  }

  get enabled() {
    return Boolean(this.config.telegram.botToken && this.config.telegram.freeChatId);
  }

  async start() {
    if (!this.enabled) {
      this.log.warn('Telegram disabled — set TELEGRAM_BOT_TOKEN + TELEGRAM_FREE_CHAT_ID');
      return;
    }
    this.log.info('Telegram channel ready', {
      free: Boolean(this.config.telegram.freeChatId),
      premium: Boolean(this.config.telegram.premiumChatId),
    });
  }

  status() {
    return { enabled: this.enabled, ...this.stats };
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

  async sendOps(text) {
    const chatId =
      this.config.telegram.opsChatId ||
      this.config.telegram.premiumChatId ||
      this.config.telegram.freeChatId;
    if (!this.enabled || !chatId) return false;
    try {
      await this.post(chatId, `🛡 *OPS*\n${text}`);
      return true;
    } catch {
      return false;
    }
  }

  async send(alert) {
    if (!this.enabled) return false;
    let ok = false;

    if (alert.tier !== 'premium-only') {
      try {
        const payload = alert.tier === 'premium' ? this.freeTeaser(alert) : alert;
        await this.post(
          this.config.telegram.freeChatId,
          formatTelegram(this.config, payload, { premium: false })
        );
        this.stats.free += 1;
        ok = true;
      } catch (err) {
        this.stats.errors += 1;
        this.log.error('Telegram free send failed', { error: err.message });
      }
    }

    if (
      this.config.telegram.premiumChatId &&
      (alert.tier === 'premium' || alert.tier === 'premium-only')
    ) {
      try {
        await this.post(
          this.config.telegram.premiumChatId,
          formatTelegram(this.config, alert, { premium: true })
        );
        this.stats.premium += 1;
        ok = true;
      } catch (err) {
        this.stats.errors += 1;
        this.log.error('Telegram premium send failed', { error: err.message });
      }
    }

    return ok;
  }
}

module.exports = { TelegramChannel };
