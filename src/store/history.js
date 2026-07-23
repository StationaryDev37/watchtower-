/**
 * Alert history, outcomes, funnel — sync prepared statements on the shared Db.
 */
'use strict';

class History {
  constructor(db, log) {
    this.dbHandle = db; // Db instance
    this.log = log;
    this.db = null;
  }

  start() {
    this.db = this.dbHandle.db || this.dbHandle;
    this.insertAlert = this.db.prepare(`
      INSERT INTO alert_history
        (ts, signal_type, symbol, tier, conviction, payload_json, entry_price, degraded)
      VALUES
        (@ts, @signal_type, @symbol, @tier, @conviction, @payload_json, @entry_price, @degraded)
    `);
    this.insertOutcome = this.db.prepare(`
      INSERT OR REPLACE INTO alert_outcomes
        (alert_id, ts_scored, p_15m, p_1h, p_4h, p_24h, max_fav_bps, max_adv_bps, hit_positive)
      VALUES
        (@alert_id, @ts_scored, @p_15m, @p_1h, @p_4h, @p_24h, @max_fav_bps, @max_adv_bps, @hit_positive)
    `);
    this.pendingOutcomes = this.db.prepare(`
      SELECT id, ts, symbol, entry_price, signal_type
      FROM alert_history
      WHERE entry_price IS NOT NULL
        AND ts <= @cutoff
        AND id NOT IN (SELECT alert_id FROM alert_outcomes)
      ORDER BY ts ASC
      LIMIT @lim
    `);
    this.insertFunnel = this.db.prepare(`
      INSERT INTO funnel_events (ts, session_id, event, variant, meta_json)
      VALUES (@ts, @session_id, @event, @variant, @meta_json)
    `);
    this.count24hStmt = this.db.prepare(
      `SELECT COUNT(*) AS c FROM alert_history WHERE ts >= ?`
    );
    return this;
  }

  recordAlert(alert, { entryPrice = null, degraded = false } = {}) {
    // Accept either framework alert object or explicit history row
    const row = {
      ts: alert.ts ?? Date.now(),
      signal_type: alert.signal_type || alert.type || 'unknown',
      symbol: alert.symbol ?? null,
      tier: normalizeTier(alert.tier),
      conviction: alert.conviction ?? null,
      payload_json:
        typeof alert.payload_json === 'string'
          ? alert.payload_json
          : JSON.stringify(alert.payload ?? alert).slice(0, 16000),
      entry_price: entryPrice ?? alert.entry_price ?? alert.entryPrice ?? null,
      degraded: degraded || alert.degraded ? 1 : 0,
    };
    const info = this.insertAlert.run(row);
    return info.lastInsertRowid;
  }

  recordOutcome(o) {
    this.insertOutcome.run(o);
  }

  listPendingOutcomes(cutoffMs, lim = 500) {
    return this.pendingOutcomes.all({ cutoff: cutoffMs, lim });
  }

  recordFunnel(e) {
    this.insertFunnel.run({
      ts: e.ts ?? Date.now(),
      session_id: e.session_id || e.sessionId || 'anon',
      event: e.event,
      variant: e.variant ?? null,
      meta_json: e.meta || e.meta_json ? JSON.stringify(e.meta || e.meta_json) : null,
    });
  }

  recentAlerts(limit = 20) {
    return this.db
      .prepare(
        `SELECT id, ts, signal_type, symbol, tier, conviction, entry_price
         FROM alert_history ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }

  alertCount24h() {
    const since = Date.now() - 24 * 3600 * 1000;
    return this.count24hStmt.get(since)?.c || 0;
  }

  coalesceRate24h() {
    const since = Date.now() - 24 * 3600 * 1000;
    const rows = this.db
      .prepare(
        `SELECT payload_json FROM alert_history WHERE ts >= ? AND tier != 'public'`
      )
      .all(since);
    if (!rows.length) return 0;
    let merged = 0;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload_json);
        if (p.coalesced || (p.sources && p.sources.length > 1)) merged += 1;
      } catch {
        /* ignore */
      }
    }
    return merged / rows.length;
  }

  outcomesForTraining(limit = 100000) {
    return this.db
      .prepare(
        `SELECT h.payload_json, h.conviction, o.hit_positive, h.ts
         FROM alert_outcomes o
         JOIN alert_history h ON h.id = o.alert_id
         WHERE o.hit_positive IS NOT NULL
         ORDER BY o.ts_scored DESC LIMIT ?`
      )
      .all(limit);
  }

  status() {
    return {
      alerts24h: this.alertCount24h(),
      coalesceRate24h: this.coalesceRate24h(),
    };
  }
}

function normalizeTier(tier) {
  if (tier === 'premium-only') return 'premium';
  if (tier === 'premium_alpha' || tier === 'premium' || tier === 'public') return tier;
  return 'public';
}

module.exports = { History };
