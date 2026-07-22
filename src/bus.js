/**
 * AlertBus — Commit A baseline (history recording).
 * Commit B extends with dedup / coalesce / priority lanes.
 */

class AlertBus {
  constructor(config, log, { history } = {}) {
    this.config = config;
    this.log = log;
    this.history = history || null;
    this.handlers = [];
    this.cooldowns = new Map();
    this.ingress = new Map();
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

  bumpIngress(type) {
    const now = Date.now();
    const arr = this.ingress.get(type) || [];
    arr.push(now);
    this.ingress.set(
      type,
      arr.filter((t) => now - t < 60_000)
    );
  }

  async publish(alert) {
    const key = alert.key || `${alert.type}:${alert.title}`;
    this.stats.published += 1;
    this.bumpIngress(alert.type || 'unknown');

    if (!this.canSend(key)) {
      this.stats.cooled += 1;
      return { sent: false, reason: 'cooldown' };
    }

    this.history?.recordAlert(alert, {
      entryPrice: alert.entryPrice ?? null,
      degraded: Boolean(alert.degraded),
    });

    if (this.config.dryRun) {
      this.log.info('DRY_RUN alert', {
        title: alert.title,
        tier: alert.tier,
        z: alert.features?.z,
      });
      this.markSent(key);
      this.stats.delivered += 1;
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

  ingressPerMin() {
    const out = {};
    for (const [k, arr] of this.ingress) out[k] = arr.length;
    return out;
  }

  stop() {
    this.handlers = [];
    this.cooldowns.clear();
  }
}

module.exports = { AlertBus };
