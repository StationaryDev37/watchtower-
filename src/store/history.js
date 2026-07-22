/**
 * Alert history, outcomes, funnel — ground truth for ConvictionScorer.
 */
class History {
  constructor(db, log) {
    this.db = db;
    this.log = log;
    this._insertAlert = null;
    this._insertFunnel = null;
  }

  start() {
    this._insertAlert = this.db.prepare(`
      INSERT INTO alert_history
        (ts, signal_type, symbol, tier, conviction, payload_json, entry_price, degraded)
      VALUES
        (@ts, @signal_type, @symbol, @tier, @conviction, @payload_json, @entry_price, @degraded)
    `);
    this._insertFunnel = this.db.prepare(`
      INSERT INTO funnel_events (ts, session_id, event, variant, meta_json)
      VALUES (@ts, @session_id, @event, @variant, @meta_json)
    `);
    this._insertOutcome = this.db.prepare(`
      INSERT OR REPLACE INTO alert_outcomes
        (alert_id, ts_scored, p_15m, p_1h, p_4h, p_24h, max_fav, max_adv, hit_positive)
      VALUES
        (@alert_id, @ts_scored, @p_15m, @p_1h, @p_4h, @p_24h, @max_fav, @max_adv, @hit_positive)
    `);
    return this;
  }

  recordAlert(alert, { entryPrice = null, degraded = false } = {}) {
    const info = this._insertAlert.run({
      ts: Date.now(),
      signal_type: alert.type || 'unknown',
      symbol: alert.symbol || null,
      tier: alert.tier || 'public',
      conviction: alert.conviction ?? null,
      payload_json: JSON.stringify(alert).slice(0, 16000),
      entry_price: entryPrice ?? alert.entryPrice ?? null,
      degraded: degraded || alert.degraded ? 1 : 0,
    });
    return info.lastInsertRowid;
  }

  recordFunnel(event, { sessionId = 'anon', variant = null, meta = {} } = {}) {
    this._insertFunnel.run({
      ts: Date.now(),
      session_id: sessionId,
      event,
      variant,
      meta_json: JSON.stringify(meta).slice(0, 2000),
    });
  }

  recordOutcome(row) {
    this._insertOutcome.run(row);
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
    return (
      this.db.prepare(`SELECT COUNT(*) AS c FROM alert_history WHERE ts >= ?`).get(since)?.c || 0
    );
  }

  coalesceRate24h() {
    const since = Date.now() - 24 * 3600 * 1000;
    const rows = this.db
      .prepare(`SELECT payload_json FROM alert_history WHERE ts >= ? AND tier != 'public'`)
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

  pendingOutcomeAlerts(maxAgeMs, minAgeMs) {
    const now = Date.now();
    return this.db
      .prepare(
        `SELECT h.id, h.ts, h.symbol, h.entry_price, h.payload_json
         FROM alert_history h
         LEFT JOIN alert_outcomes o ON o.alert_id = h.id
         WHERE o.alert_id IS NULL
           AND h.entry_price IS NOT NULL
           AND h.ts <= ? AND h.ts >= ?
         LIMIT 200`
      )
      .all(now - minAgeMs, now - maxAgeMs);
  }

  status() {
    return {
      alerts24h: this.alertCount24h(),
      coalesceRate24h: this.coalesceRate24h(),
    };
  }
}

module.exports = { History };
