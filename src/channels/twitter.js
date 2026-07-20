const { TwitterApi } = require('twitter-api-v2');

class TwitterChannel {
  constructor(config, log) {
    this.name = 'twitter';
    this.config = config;
    this.log = log;
    this.client = null;
    this.stats = { sent: 0, errors: 0 };
  }

  get enabled() {
    const t = this.config.twitter;
    return Boolean(t.apiKey && t.apiSecret && t.accessToken && t.accessSecret);
  }

  async start() {
    if (!this.enabled) {
      this.log.warn('Twitter disabled — missing OAuth 1.0a credentials');
      return;
    }
    const t = this.config.twitter;
    this.client = new TwitterApi({
      appKey: t.apiKey,
      appSecret: t.apiSecret,
      accessToken: t.accessToken,
      accessSecret: t.accessSecret,
    });
    this.log.info('Twitter channel ready');
  }

  async stop() {
    this.client = null;
  }

  status() {
    return { enabled: this.enabled, ...this.stats };
  }

  format(alert) {
    const brand = this.config.brand;
    const upgrade =
      alert.monetization?.tweetUpgradeUrl ||
      this.config.growth.tweetUpgradeUrl ||
      alert.monetization?.upgradeUrl ||
      '';
    const affiliate = alert.monetization?.affiliateUrl || '';
    const links = [upgrade, affiliate].filter(Boolean);
    const linkBlock = links.length ? `\n${links[0]}` : alert.url ? `\n${alert.url}` : '';
    const base = `🛡 ${brand}: ${alert.title}\n${alert.body}`;
    const max = 280 - linkBlock.length;
    const text = base.length > max ? `${base.slice(0, Math.max(0, max - 1))}…` : base;
    return text + linkBlock;
  }

  async send(alert) {
    if (!this.enabled || !this.client) return false;
    // Keep Twitter on free/public tier for acquisition; premium stays Telegram-exclusive
    if (alert.tier === 'premium-only') return false;
    try {
      await this.client.v2.tweet(this.format(alert));
      this.stats.sent += 1;
      return true;
    } catch (err) {
      this.stats.errors += 1;
      this.log.error('Twitter send failed', { error: err.message });
      return false;
    }
  }
}

module.exports = { TwitterChannel };
