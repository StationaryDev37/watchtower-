/**
 * AlertBus — dedup + coalesce + priority lanes.
 *
 * Dedup: identical fingerprint inside DEDUP_WINDOW_MS → drop.
 * Coalesce: same coalesceKey inside COALESCE_WINDOW_MS → merge sources.
 * Lanes: premium_alpha : premium : public = 6:3:1 weighted RR at dispatch.
 */

class AlertBus {
  constructor(config, log, { history, scorer } = {}) {
    this.config = config;
    this.log = log;
    this.history = history || null;
    this.scorer = scorer || null;
    this.handlers = [];
    this.cooldowns = new Map();
    this.dedup = new Map();
    this.pending = new Map();
    this.queues = {
      premium_alpha: [],
      premium: [],
      public: [],
    };
    this.ingress = new Map();
    this.pumping = false;
    this.stats = {
      published: 0,
      delivered: 0,
      cooled: 0,
      deduped: 0,
      coalesced: 0,
      errors: 0,
    };
    this._rr = 0;
  }

  onAlert(handler) {
    this.handlers.push(handler);
  }

  fingerprint(alert) {
    return `${alert.type}|${alert.symbol || ''}|${alert.title}|${alert.tier}`;
  }

  coalesceKey(alert) {
    return alert.coalesceKey || `${alert.type}:${alert.symbol || alert.title}`;
  }

  laneOf(alert) {
    if (alert.lane === 'premium_alpha' || alert.tier === 'premium_alpha') return 'premium_alpha';
    if (alert.tier === 'premium' || alert.tier === 'premium-only') return 'premium';
    return 'public';
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

  ingressPerMin() {
    const out = {};
    for (const [k, arr] of this.ingress) out[k] = arr.length;
    return out;
  }

  async publish(alert) {
    this.stats.published += 1;
    this.bumpIngress(alert.type || 'unknown');

    const windowMs =
      alert.coalesceMs != null ? alert.coalesceMs : this.config.bus.coalesceMs;
    const dedupMs = this.config.bus.dedupMs;
    const fp = this.fingerprint(alert);
    const now = Date.now();

    // Dedup
    const lastFp = this.dedup.get(fp);
    if (lastFp && now - lastFp < dedupMs) {
      this.stats.deduped += 1;
      return { sent: false, reason: 'dedup' };
    }
    this.dedup.set(fp, now);

    if (windowMs <= 0) {
      return this.enqueue(alert);
    }

    const cKey = this.coalesceKey(alert);
    const existing = this.pending.get(cKey);
    if (existing) {
      this.stats.coalesced += 1;
      existing.sources.add(alert.source || alert.type);
      existing.alert = mergeAlerts(existing.alert, alert);
      existing.alert.coalesced = true;
      existing.alert.sources = [...existing.sources];
      return { sent: false, reason: 'coalescing' };
    }

    const entry = {
      alert: { ...alert },
      sources: new Set([alert.source || alert.type]),
      timer: null,
    };
    entry.timer = setTimeout(() => {
      this.pending.delete(cKey);
      if (entry.sources.size > 1) {
        entry.alert.coalesced = true;
        entry.alert.sources = [...entry.sources];
        entry.alert.features = {
          ...(entry.alert.features || {}),
          coalesced: 1,
        };
      }
      this.enqueue(entry.alert).catch((err) =>
        this.log.error('coalesce enqueue failed', { error: err.message })
      );
    }, windowMs);
    if (entry.timer.unref) entry.timer.unref();
    this.pending.set(cKey, entry);
    return { sent: false, reason: 'coalesce_window' };
  }

  async enqueue(alert) {
    // Conviction stamp
    if (this.scorer && this.config.conviction.enabled) {
      const c = this.scorer.score(alert);
      if (c != null) {
        alert.conviction = c.conviction;
        alert.convictionMeta = c.meta;
      }
    }

    const key = alert.key || `${alert.type}:${alert.title}`;
    const last = this.cooldowns.get(key) || 0;
    if ((Date.now() - last) / 1000 < this.config.alertCooldownSec) {
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
        conviction: alert.conviction,
        coalesced: alert.coalesced,
      });
      this.cooldowns.set(key, Date.now());
      this.stats.delivered += 1;
      return { sent: true, dryRun: true };
    }

    const lane = this.laneOf(alert);
    this.queues[lane].push({ alert, key });
    this.pump();
    return { sent: true, queued: true, lane };
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // weighted RR 6:3:1
      const schedule = [
        'premium_alpha',
        'premium_alpha',
        'premium_alpha',
        'premium_alpha',
        'premium_alpha',
        'premium_alpha',
        'premium',
        'premium',
        'premium',
        'public',
      ];
      while (
        this.queues.premium_alpha.length ||
        this.queues.premium.length ||
        this.queues.public.length
      ) {
        let job = null;
        for (let i = 0; i < schedule.length; i++) {
          const lane = schedule[(this._rr + i) % schedule.length];
          if (this.queues[lane].length) {
            job = this.queues[lane].shift();
            this._rr = (this._rr + i + 1) % schedule.length;
            break;
          }
        }
        if (!job) break;
        await this.dispatch(job.alert, job.key);
        await sleep(1000 / Math.max(1, this.config.bus.tgGlobalRate));
      }
    } finally {
      this.pumping = false;
    }
  }

  async dispatch(alert, key) {
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
      this.cooldowns.set(key, Date.now());
      this.stats.delivered += 1;
    }
    return { sent: any };
  }

  async drain() {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      await this.enqueue(entry.alert);
    }
    this.pending.clear();
    while (
      this.queues.premium_alpha.length ||
      this.queues.premium.length ||
      this.queues.public.length
    ) {
      await this.pump();
      await sleep(10);
    }
  }

  getStats() {
    return {
      ...this.stats,
      queues: {
        premium_alpha: this.queues.premium_alpha.length,
        premium: this.queues.premium.length,
        public: this.queues.public.length,
      },
      pendingCoalesce: this.pending.size,
    };
  }

  stop() {
    for (const e of this.pending.values()) {
      if (e.timer) clearTimeout(e.timer);
    }
    this.pending.clear();
    this.handlers = [];
  }
}

function mergeAlerts(a, b) {
  const fields = [...(a.fields || [])];
  for (const f of b.fields || []) {
    if (!fields.some((x) => x.label === f.label && String(x.value) === String(f.value))) {
      fields.push(f);
    }
  }
  const features = { ...(a.features || {}), ...(b.features || {}) };
  for (const k of ['z', 'zVol', 'funding_dev', 'liq_asym']) {
    features[k] = Math.max(Number(a.features?.[k] || 0), Number(b.features?.[k] || 0));
  }
  return {
    ...a,
    ...b,
    title: a.title,
    body: String(b.body || '').length > String(a.body || '').length ? b.body : a.body,
    fields,
    features,
    tier: rankTier(a.tier) >= rankTier(b.tier) ? a.tier : b.tier,
    coalesced: true,
  };
}

function rankTier(t) {
  if (t === 'premium_alpha' || t === 'premium-only') return 3;
  if (t === 'premium') return 2;
  return 1;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { AlertBus };
