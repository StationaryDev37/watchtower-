/**
 * AlertBus — Commit B: dedup, symbol coalesce, priority lanes, deliver egress.
 *
 * Signals emit via publish() or bus.emit('alert', env).
 * Channels subscribe via onAlert() or bus.on('deliver', env).
 * Lanes: premium_alpha : premium : public = 6:3:1 with token-bucket RPS.
 */
'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const LANE_WEIGHTS = { premium_alpha: 6, premium: 3, public: 1 };

class AlertBus extends EventEmitter {
  constructor(config = {}, log = console, { history, scorer } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.history = history || null;
    this.scorer = scorer || null;

    this.DEDUP_MS = Number(config?.bus?.dedupMs ?? process.env.DEDUP_WINDOW_MS ?? 3_000);
    this.COAL_MS = Number(config?.bus?.coalesceMs ?? process.env.COALESCE_WINDOW_MS ?? 5_000);
    this.GLOBAL_RPS = Number(config?.bus?.tgGlobalRate ?? process.env.TG_GLOBAL_RATE ?? 25);
    this.MAX_QUEUE = Number(config?.bus?.maxQueue ?? process.env.BUS_MAX_QUEUE ?? 500);

    this.dedup = new Map(); // key -> ts
    this.coalesceBySym = new Map(); // symbol -> { firstTs, env, timer, ids }
    this.queues = { premium_alpha: [], premium: [], public: [] };
    this.tokens = this.GLOBAL_RPS;
    this.lastRefill = Date.now();
    this.ingressCount = new Map();
    this.ingress = new Map(); // plugin -> ts[] for Watchdog ingressPerMin
    this.handlers = [];
    this.cooldowns = new Map();
    this.stats = {
      published: 0,
      delivered: 0,
      cooled: 0,
      deduped: 0,
      coalesced: 0,
      errors: 0,
    };

    this.on('alert', (env) => {
      try {
        this._onAlert(env);
      } catch (err) {
        this.stats.errors += 1;
        this.log?.error?.('AlertBus _onAlert failed', { error: err.message });
      }
    });

    this._pumpTimer = setInterval(() => this._pump(), 1000 / Math.max(1, this.GLOBAL_RPS));
    this._gcTimer = setInterval(() => this._gc(), 5_000);
    if (this._pumpTimer.unref) this._pumpTimer.unref();
    if (this._gcTimer.unref) this._gcTimer.unref();
  }

  /** Backward-compatible shim used by SignalPlugin */
  publish(alert) {
    this.stats.published += 1;
    const env = normalizeEnvelope(alert);
    this.emit('alert', env);
    return Promise.resolve({ sent: true, queued: true });
  }

  /** Backward-compatible shim used by framework channel fanout */
  onAlert(handler) {
    this.handlers.push(handler);
  }

  // --- ingress ---------------------------------------------------------
  _onAlert(env) {
    const plugin = (env.signal_type || env.type || 'unknown').split('.')[0];
    this._bumpIngress(plugin);
    const now = env.ts || Date.now();
    const key = this._dedupKey(env, now);
    const seen = this.dedup.get(key);
    if (seen && now - seen < this.DEDUP_MS) {
      this.stats.deduped += 1;
      return;
    }
    this.dedup.set(key, now);

    if (!env.symbol) return this._enqueue(env);

    const slot = this.coalesceBySym.get(env.symbol);
    if (!slot) {
      const s = {
        firstTs: now,
        env: this._cloneForMerge(env),
        timer: null,
        ids: [env.alert_id].filter(Boolean),
      };
      s.timer = setTimeout(() => this._flushCoalesce(env.symbol), this.COAL_MS);
      if (s.timer.unref) s.timer.unref();
      this.coalesceBySym.set(env.symbol, s);
    } else {
      this.stats.coalesced += 1;
      slot.env = this._merge(slot.env, env);
      if (env.alert_id) slot.ids.push(env.alert_id);
    }
  }

  _flushCoalesce(symbol) {
    const slot = this.coalesceBySym.get(symbol);
    if (!slot) return;
    this.coalesceBySym.delete(symbol);
    if (slot.timer) clearTimeout(slot.timer);
    const env = slot.env;
    if (slot.ids.length > 1 || (env.signal_types && env.signal_types.length > 1)) {
      env.payload = env.payload || {};
      env.payload.coalesced_ids = slot.ids;
      env.features = env.features || {};
      env.features.x7 = 1;
      env.coalesced = true;
      if (!String(env.signal_type || '').includes('+coalesced')) {
        env.signal_type = `${env.signal_type}+coalesced`;
      }
      // Force a fresh history row for the merged envelope.
      env.alert_id = null;
    }
    this._enqueue(env);
  }

  _merge(a, b) {
    const tierRank = { public: 0, premium: 1, 'premium-only': 1, premium_alpha: 2 };
    const out = { ...a };
    out.tier = tierRank[b.tier] > tierRank[a.tier] ? b.tier : a.tier;
    out.ts = Math.max(a.ts || 0, b.ts || 0);
    out.signal_types = Array.from(
      new Set([...(a.signal_types || [a.signal_type]), b.signal_type].filter(Boolean))
    );
    const bKey = b.signal_type || b.type || 'extra';
    out.payload = { ...(a.payload || {}), [bKey]: b.payload || b };
    out.features = {
      x1: Math.max(a.features?.x1 || 0, b.features?.x1 || 0),
      x2: Math.max(a.features?.x2 || 0, b.features?.x2 || 0),
      x3: Math.max(a.features?.x3 || 0, b.features?.x3 || 0),
      x4: Math.max(a.features?.x4 || 0, b.features?.x4 || 0),
      x6: a.features?.x6 ?? b.features?.x6 ?? 1.0,
      x7: 1,
      z: Math.max(a.features?.z || 0, b.features?.z || 0),
      zVol: Math.max(a.features?.zVol || 0, b.features?.zVol || 0),
      funding_dev: Math.max(a.features?.funding_dev || 0, b.features?.funding_dev || 0),
      liq_asym: Math.max(a.features?.liq_asym || 0, b.features?.liq_asym || 0),
    };
    out.degraded = Boolean(a.degraded || b.degraded);
    // Prefer richer title/body for channel rendering
    if ((b.title || '').length > (a.title || '').length) out.title = b.title;
    if ((b.body || '').length > (a.body || '').length) out.body = b.body;
    out.fields = mergeFields(a.fields, b.fields);
    out.type = a.type || b.type;
    out.key = a.key || b.key;
    out.coalesceKey = a.coalesceKey || b.coalesceKey;
    out.sources = Array.from(
      new Set([...(a.sources || []), a.source || a.type, b.source || b.type].filter(Boolean))
    );
    return out;
  }

  _cloneForMerge(env) {
    return {
      ...env,
      signal_types: [env.signal_type].filter(Boolean),
      payload: env.payload ? { ...(env.payload || {}) } : {},
      features: { ...(env.features || {}) },
    };
  }

  _dedupKey(env, now) {
    const bucket = Math.floor(now / this.DEDUP_MS);
    const st = env.signal_type || env.type || '';
    return crypto
      .createHash('sha1')
      .update(`${st}|${env.symbol || ''}|${bucket}`)
      .digest('hex');
  }

  // --- egress ----------------------------------------------------------
  _enqueue(env) {
    if (this.scorer && this.config?.conviction?.enabled) {
      try {
        const c = this.scorer.score(env);
        if (c != null) {
          env.conviction = c.conviction;
          env.convictionMeta = c.meta;
        }
      } catch (err) {
        this.log?.warn?.('conviction score failed', { error: err.message });
      }
    }

    const cdKey = env.key || `${env.signal_type || env.type}:${env.symbol || env.title || ''}`;
    const cooldownSec = this.config?.alertCooldownSec ?? 0;
    if (cooldownSec > 0) {
      const last = this.cooldowns.get(cdKey) || 0;
      if ((Date.now() - last) / 1000 < cooldownSec) {
        this.stats.cooled += 1;
        return;
      }
    }

    const lane = this._laneOf(env);
    const q = this.queues[lane] || this.queues.public;
    if (q.length >= this.MAX_QUEUE) {
      if (lane === 'public') this._shedPublic();
      else this.emit('backpressure', { lane, size: q.length });
    }

    if (env.features?.x7 === 1 && !env.alert_id) {
      env.alert_id = this._record(env);
    } else if (!env.alert_id) {
      env.alert_id = this._record(env);
    }

    if (this.config?.dryRun) {
      this.log?.info?.('DRY_RUN alert', {
        title: env.title,
        tier: env.tier,
        signal_type: env.signal_type,
        conviction: env.conviction,
        coalesced: env.coalesced || env.features?.x7 === 1,
      });
      this.cooldowns.set(cdKey, Date.now());
      this.stats.delivered += 1;
      this.emit('deliver', env);
      return;
    }

    q.push({ env, key: cdKey });
    this.emit('enqueued', { lane, size: q.length });
  }

  _record(env) {
    if (!this.history?.recordAlert) return null;
    try {
      return this.history.recordAlert(env, {
        entryPrice: env.entry_price ?? env.entryPrice ?? null,
        degraded: Boolean(env.degraded),
      });
    } catch (err) {
      this.log?.error?.('history.recordAlert failed', { error: err.message });
      return null;
    }
  }

  _shedPublic() {
    const q = this.queues.public;
    if (q.length < 8) return;
    const digest = q.splice(0, q.length).map((j) => j.env || j);
    const env = {
      ts: Date.now(),
      signal_type: 'digest.public',
      type: 'digest',
      symbol: null,
      tier: 'public',
      title: `Public digest (${digest.length})`,
      body: `${digest.length} public alerts collapsed under backpressure`,
      payload: {
        count: digest.length,
        samples: digest.slice(-5).map((e) => ({
          signal_type: e.signal_type,
          symbol: e.symbol,
          ts: e.ts,
        })),
      },
      features: { x1: 0, x2: 0, x7: 0 },
    };
    env.alert_id = this._record(env);
    q.push({ env, key: `digest:${env.ts}` });
  }

  _pump() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.GLOBAL_RPS, this.tokens + elapsed * this.GLOBAL_RPS);
    this.lastRefill = now;
    if (this.tokens < 1) return;

    const order = this._laneOrder();
    for (const lane of order) {
      if (this.tokens < 1) break;
      const q = this.queues[lane];
      if (!q.length) continue;
      const job = q.shift();
      this.tokens -= 1;
      this._dispatch(job.env || job, job.key);
    }
  }

  _laneOrder() {
    const out = [];
    const remaining = { ...LANE_WEIGHTS };
    while (Object.values(remaining).some((v) => v > 0)) {
      for (const [k, v] of Object.entries(remaining)) {
        if (v > 0) {
          out.push(k);
          remaining[k] = v - 1;
        }
      }
    }
    return out;
  }

  _laneOf(env) {
    if (env.lane === 'premium_alpha' || env.tier === 'premium_alpha') return 'premium_alpha';
    if (env.tier === 'premium' || env.tier === 'premium-only') return 'premium';
    return 'public';
  }

  async _dispatch(env, key) {
    this.emit('deliver', env);
    let any = false;
    for (const handler of this.handlers) {
      try {
        const result = await handler(env);
        if (result?.sent) any = true;
      } catch (err) {
        this.stats.errors += 1;
        this.log?.error?.('Alert handler failed', { error: err.message, key });
      }
    }
    if (any || this.handlers.length === 0) {
      if (key) this.cooldowns.set(key, Date.now());
      this.stats.delivered += 1;
    }
  }

  // --- housekeeping ----------------------------------------------------
  _gc() {
    const cutoff = Date.now() - Math.max(this.DEDUP_MS, this.COAL_MS) * 4;
    for (const [k, ts] of this.dedup) if (ts < cutoff) this.dedup.delete(k);
    for (const [k, v] of this.ingressCount) this.ingressCount.set(k, Math.max(0, v * 0.9));
    const now = Date.now();
    for (const [k, arr] of this.ingress) {
      this.ingress.set(
        k,
        arr.filter((t) => now - t < 60_000)
      );
    }
  }

  _bumpIngress(plugin) {
    this.ingressCount.set(plugin, (this.ingressCount.get(plugin) || 0) + 1);
    const now = Date.now();
    const arr = this.ingress.get(plugin) || [];
    arr.push(now);
    this.ingress.set(
      plugin,
      arr.filter((t) => now - t < 60_000)
    );
  }

  ingressPerMin() {
    const out = {};
    for (const [k, arr] of this.ingress) out[k] = arr.length;
    return out;
  }

  noisiestPlugin() {
    let best = null;
    let val = -1;
    for (const [k, v] of this.ingressCount) {
      if (v > val) {
        val = v;
        best = k;
      }
    }
    return best;
  }

  snapshot() {
    return {
      queues: Object.fromEntries(Object.entries(this.queues).map(([k, v]) => [k, v.length])),
      dedup_size: this.dedup.size,
      coalescing: this.coalesceBySym.size,
      tokens: Math.round(this.tokens * 10) / 10,
      ingress: Object.fromEntries(this.ingressCount),
    };
  }

  getStats() {
    return {
      ...this.stats,
      ...this.snapshot(),
      pendingCoalesce: this.coalesceBySym.size,
    };
  }

  async drain() {
    for (const [sym, slot] of this.coalesceBySym) {
      if (slot.timer) clearTimeout(slot.timer);
      this._flushCoalesce(sym);
    }
    // Pump until empty (bounded)
    for (let i = 0; i < 10_000; i++) {
      const pending =
        this.queues.premium_alpha.length +
        this.queues.premium.length +
        this.queues.public.length;
      if (!pending) break;
      this.tokens = this.GLOBAL_RPS;
      this._pump();
      await sleep(5);
    }
  }

  stop() {
    clearInterval(this._pumpTimer);
    clearInterval(this._gcTimer);
    for (const slot of this.coalesceBySym.values()) {
      if (slot.timer) clearTimeout(slot.timer);
    }
    this.coalesceBySym.clear();
    this.handlers = [];
    this.removeAllListeners();
  }
}

function normalizeEnvelope(alert) {
  const featuresIn = alert.features || {};
  return {
    ...alert,
    signal_type: alert.signal_type || alert.type || 'unknown',
    type: alert.type || (alert.signal_type || 'unknown').split('.')[0],
    ts: alert.ts || Date.now(),
    tier: alert.tier || 'public',
    symbol: alert.symbol ?? null,
    entry_price: alert.entry_price ?? alert.entryPrice ?? null,
    degraded: Boolean(alert.degraded),
    payload: alert.payload || {
      title: alert.title,
      body: alert.body,
      fields: alert.fields,
    },
    features: {
      x1: featuresIn.x1 ?? Math.abs(featuresIn.z || 0),
      x2: featuresIn.x2 ?? Math.max(0, featuresIn.zVol || 0),
      x3: featuresIn.x3 ?? Math.abs(featuresIn.funding_dev || 0),
      x4: featuresIn.x4 ?? Math.abs(featuresIn.liq_asym || 0),
      x6: featuresIn.x6 ?? 1.0,
      x7: featuresIn.x7 ?? featuresIn.coalesced ?? 0,
      ...featuresIn,
    },
  };
}

function mergeFields(a = [], b = []) {
  const fields = [...(a || [])];
  for (const f of b || []) {
    if (!fields.some((x) => x.label === f.label && String(x.value) === String(f.value))) {
      fields.push(f);
    }
  }
  return fields;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { AlertBus };
