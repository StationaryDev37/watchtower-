const axios = require('axios');

class DiscordChannel {
  constructor(config, log) {
    this.name = 'discord';
    this.config = config;
    this.log = log;
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

  async stop() {}

  status() {
    return { enabled: this.enabled, ...this.stats };
  }

  async send(alert) {
    if (!this.enabled || alert.tier === 'premium-only') return false;
    try {
      const fields = (alert.fields || []).slice(0, 6).map((f) => ({
        name: f.label,
        value: String(f.value).slice(0, 200),
        inline: true,
      }));
      await axios.post(
        this.config.discord.webhookUrl,
        {
          username: this.config.brand,
          embeds: [
            {
              title: alert.title,
              description: alert.body,
              url: alert.monetization?.upgradeUrl || alert.url,
              color: 0x0ea5e9,
              fields,
            },
          ],
        },
        { timeout: 15000 }
      );
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
