/**
 * AlertBus — single in-process event spine.
 * Signals publish; framework routes; channels consume.
 */

class AlertBus {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.handlers = [];
    this.cooldowns = new Map();
    this.stats = { published: 0, delivered: 0, cooled: 0, errors: 0 };
  }

  onAlert(handler) {
    this.handlers.push(handler);
  }

  canSend(key) {
    const last = this.cooldowns.get(key) || 0;
    return (Date.now() - last) / 1000 >= this.config.alertCooldownSec;
  }

  markSent(key) {
    this.cooldowns.set(key, Date.now());
  }

  async publish(alert) {
    const key = alert.key || `${alert.type}:${alert.title}`;
    this.stats.published += 1;

    if (!this.canSend(key)) {
      this.stats.cooled += 1;
      this.log.debug('Alert cooled down', { key });
      return { sent: false, reason: 'cooldown' };
    }

    if (this.config.dryRun) {
      this.log.info('DRY_RUN alert', { title: alert.title, body: alert.body, tier: alert.tier });
      this.markSent(key);
      return { sent: true, dryRun: true };
    }

    let any = false;
    for (const handler of this.handlers) {
      try {
        const result = await handler({ ...alert, key });
        if (result?.sent) any = true;
      } catch (err) {
        this.stats.errors += 1;
        this.log.error('Alert handler failed', { error: err.message, key });
      }
    }

    if (any) {
      this.markSent(key);
      this.stats.delivered += 1;
    }
    return { sent: any };
  }

  getStats() {
    return { ...this.stats, cooldownKeys: this.cooldowns.size };
  }

  stop() {
    this.handlers = [];
    this.cooldowns.clear();
  }
}

module.exports = { AlertBus };
