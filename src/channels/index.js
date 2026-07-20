const { TelegramChannel } = require('./telegram');
const { TwitterChannel } = require('./twitter');
const { DiscordChannel } = require('./discord');

class ChannelRegistry {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.channels = [
      new TelegramChannel(config, log),
      new TwitterChannel(config, log),
      new DiscordChannel(config, log),
    ];
  }

  listEnabled() {
    return this.channels.filter((c) => c.enabled).map((c) => c.name);
  }

  async start() {
    for (const ch of this.channels) {
      await ch.start();
    }
  }

  async stop() {
    for (const ch of this.channels) {
      await ch.stop();
    }
  }

  status() {
    return Object.fromEntries(this.channels.map((c) => [c.name, c.status()]));
  }

  async dispatch(alert) {
    const results = {};
    let sent = false;
    for (const ch of this.channels) {
      if (!ch.enabled) continue;
      try {
        const ok = await ch.send(alert);
        results[ch.name] = ok;
        if (ok) sent = true;
      } catch (err) {
        results[ch.name] = false;
        this.log.error(`${ch.name} dispatch failed`, { error: err.message });
      }
    }
    if (sent) this.log.info('Alert dispatched', { key: alert.key, results });
    return { sent, results };
  }
}

module.exports = { ChannelRegistry };
