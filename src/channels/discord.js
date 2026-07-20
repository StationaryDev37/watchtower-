const axios = require('axios');
const { ChannelPlugin } = require('./base');
const { formatDiscord } = require('../templates/alerts');

class DiscordChannel extends ChannelPlugin {
  constructor(config, log) {
    super(config, log);
    this.name = 'discord';
    this.stats = { sent: 0, errors: 0 };
  }

  get enabled() {
    return Boolean(this.config.discord.webhookUrl);
  }

  async start() {
    if (!this.enabled) {
      this.log.info('Discord optional — set DISCORD_WEBHOOK_URL to enable');
      return;
    }
    this.log.info('Discord channel ready');
  }

  status() {
    return { enabled: this.enabled, ...this.stats };
  }

  async send(alert) {
    if (!this.enabled || alert.tier === 'premium-only') return false;
    try {
      await axios.post(this.config.discord.webhookUrl, formatDiscord(this.config, alert), {
        timeout: 15000,
      });
      this.stats.sent += 1;
      return true;
    } catch (err) {
      this.stats.errors += 1;
      this.log.error('Discord send failed', { error: err.message });
      return false;
    }
  }
}

module.exports = { DiscordChannel };
