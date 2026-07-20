const axios = require('axios');

function escapeMd(text) {
  return String(text).replace(/([_*`\[])/g, '\\$1');
}

class TelegramChannel {
  constructor(config, log) {
    this.name = 'telegram';
    this.config = config;
    this.log = log;
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

  async stop() {}

  status() {
    return { enabled: this.enabled, ...this.stats };
  }

  format(alert, { premium }) {
    const brand = this.config.brand;
    const lines = [
      `🛡 *${escapeMd(brand)} ${premium ? 'PREMIUM' : 'ALERT'}*`,
      `*${escapeMd(alert.title)}*`,
      '',
      escapeMd(alert.body),
    ];
    if (alert.fields?.length) {
      lines.push('');
      for (const f of alert.fields) {
        lines.push(`• *${escapeMd(f.label)}:* ${escapeMd(String(f.value))}`);
      }
    }
    if (alert.url) lines.push('', `[Open](${alert.url})`);
    if (alert.monetization?.affiliateUrl) {
      lines.push(
        '',
        `[${escapeMd(alert.monetization.affiliateLabel)}](${alert.monetization.affiliateUrl})`
      );
    }
    if (!premium && alert.monetization?.upgradeUrl) {
      lines.push('', `[Upgrade to Premium](${alert.monetization.upgradeUrl})`);
    }
    if (premium && alert.tier === 'premium') {
      lines.push('', '_Premium signal · early edge_');
    }
    return lines.join('\n');
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
    // Paid wedge: free channel sees a teaser + upgrade CTA, not full whale detail
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

  async send(alert) {
    if (!this.enabled) return false;
    let ok = false;

    // Free channel = growth (public full + premium teasers)
    if (alert.tier !== 'premium-only') {
      try {
        const payload = alert.tier === 'premium' ? this.freeTeaser(alert) : alert;
        await this.post(this.config.telegram.freeChatId, this.format(payload, { premium: false }));
        this.stats.free += 1;
        ok = true;
      } catch (err) {
        this.stats.errors += 1;
        this.log.error('Telegram free send failed', { error: err.message });
      }
    }

    // Premium channel = full whale / strong signals
    if (
      this.config.telegram.premiumChatId &&
      (alert.tier === 'premium' || alert.tier === 'premium-only')
    ) {
      try {
        await this.post(this.config.telegram.premiumChatId, this.format(alert, { premium: true }));
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
