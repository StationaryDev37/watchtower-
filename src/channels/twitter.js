const { TwitterApi } = require('twitter-api-v2');
const { ChannelPlugin } = require('./base');
const { formatTweet } = require('../templates/alerts');

class TwitterChannel extends ChannelPlugin {
  constructor(config, log) {
    super(config, log);
    this.name = 'twitter';
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
    this.log.info('Twitter channel ready', { style: this.config.growth.tweetStyle });
  }

  async stop() {
    this.client = null;
  }

  status() {
    return { enabled: this.enabled, ...this.stats };
  }

  async send(alert) {
    if (!this.enabled || !this.client) return false;
    if (alert.tier === 'premium-only') return false;
    // Public acquisition only — teasers for premium, full for public
    const payload =
      alert.tier === 'premium'
        ? {
            ...alert,
            title: alert.type === 'whale' ? 'Whale activity detected' : alert.title,
            body:
              alert.type === 'whale'
                ? 'On-chain size moving. Premium has the wallets + tx.'
                : alert.body,
          }
        : alert;
    try {
      await this.client.v2.tweet(formatTweet(this.config, payload));
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
