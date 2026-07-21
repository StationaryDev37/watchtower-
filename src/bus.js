/**
 * AlertBus — cooldown + dedup/coalesce.
 * Same coalesceKey from two sources inside coalesceMs → one enriched alert.
 */

class AlertBus {
  constructor(config, log, { store } = {}) {
    this.config = config;
    this.log = log;
    this.store = store || null;
    this.handlers = [];
    this.cooldowns = new Map();
    this.pending = new Map(); // coalesceKey -> { alert, sources, timer }
    this.stats = {
      published: 0,
      delivered: 0,
      cooled: 0,
      coalesced: 0,
      errors: 0,
    };
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

  coalesceKey(alert) {
    return alert.coalesceKey || `${alert.type}:${alert.symbol || alert.title}`;
  }

  async publish(alert) {
    this.stats.published += 1;
    const cKey = this.coalesceKey(alert);
    const windowMs =
      alert.coalesceMs != null ? alert.coalesceMs : this.config.bus.coalesceMs;

    if (windowMs <= 0) {
      return this.dispatch(alert);
    }

    const existing = this.pending.get(cKey);
    if (existing) {
      this.stats.coalesced += 1;
      existing.sources.add(alert.source || alert.type);
      existing.alert = mergeAlerts(existing.alert, alert);
      return { sent: false, reason: 'coalescing' };
    }

    const entry = {
      alert: { ...alert },
      sources: new Set([alert.source || alert.type]),
      timer: null,
    };
    entry.timer = setTimeout(() => {
      this.pending.delete(cKey);
      const merged = entry.alert;
      if (entry.sources.size > 1) {
        merged.fields = [
          ...(merged.fields || []),
          { label: 'Sources', value: [...entry.sources].join(', ') },
        ];
      }
      this.dispatch(merged).catch((err) =>
        this.log.error('Coalesced dispatch failed', { error: err.message })
      );
    }, windowMs);
    if (entry.timer.unref) entry.timer.unref();
    this.pending.set(cKey, entry);
    return { sent: false, reason: 'coalesce_window' };
  }

  async dispatch(alert) {
    const key = alert.key || `${alert.type}:${alert.title}`;

    if (!this.canSend(key)) {
      this.stats.cooled += 1;
      this.log.debug('Alert cooled down', { key });
      return { sent: false, reason: 'cooldown' };
    }

    this.store?.recordAlert(alert);

    if (this.config.dryRun) {
      this.log.info('DRY_RUN alert', { title: alert.title, body: alert.body, tier: alert.tier });
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
    return {
      ...this.stats,
      cooldownKeys: this.cooldowns.size,
      pendingCoalesce: this.pending.size,
    };
  }

  async drain() {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      await this.dispatch(entry.alert);
    }
  }

  stop() {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.handlers = [];
    this.cooldowns.clear();
  }
}

function mergeAlerts(a, b) {
  const fields = [...(a.fields || [])];
  for (const f of b.fields || []) {
    if (!fields.some((x) => x.label === f.label && x.value === f.value)) fields.push(f);
  }
  return {
    ...a,
    ...b,
    title: a.title,
    body: preferRicher(a.body, b.body),
    fields,
    tier: rankTier(a.tier) >= rankTier(b.tier) ? a.tier : b.tier,
  };
}

function preferRicher(a, b) {
  return String(b || '').length > String(a || '').length ? b : a;
}

function rankTier(t) {
  if (t === 'premium-only') return 3;
  if (t === 'premium') return 2;
  return 1;
}

module.exports = { AlertBus };
