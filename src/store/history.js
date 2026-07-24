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

  // --- SignalSession + solana whale moat --------------------------------
  upsertSession(session) {
    const row = session.toRow ? session.toRow() : session;
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, module, state, observed_at, scored_at, published_at, settled_at, payload, score_json, outcome_json)
         VALUES
           (@id, @module, @state, @observed_at, @scored_at, @published_at, @settled_at, @payload, @score_json, @outcome_json)
         ON CONFLICT(id) DO UPDATE SET
           state=excluded.state,
           scored_at=excluded.scored_at,
           published_at=excluded.published_at,
           settled_at=excluded.settled_at,
           payload=excluded.payload,
           score_json=excluded.score_json,
           outcome_json=excluded.outcome_json`
      )
      .run(row);
  }

  addReceipt(sessionId, channel, messageId = null) {
    this.db
      .prepare(
        `INSERT INTO receipts (session_id, channel, posted_at, message_id) VALUES (?,?,?,?)`
      )
      .run(sessionId, channel, Date.now(), messageId);
  }

  listSessionsForSettle(publishedBefore, lim = 20) {
    return this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE state = 'PUBLISHED'
           AND published_at IS NOT NULL
           AND published_at <= ?
         ORDER BY published_at ASC LIMIT ?`
      )
      .all(publishedBefore, lim);
  }

  recordOutcomeSession(session) {
    const o = session.outcome || {};
    this.db
      .prepare(
        `INSERT OR REPLACE INTO outcomes
           (session_id, price_at_pub, price_at_15m, price_at_1h, price_at_24h, hit)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        o.price_at_pub ?? null,
        o.price_at_15m ?? null,
        o.price_at_1h ?? null,
        o.price_at_24h ?? null,
        o.hit ?? null
      );
    this.upsertSession(session);
  }

  insertSolanaEvent({
    ts,
    sig,
    wallet,
    kind,
    solAmount,
    token,
    mint,
    dex,
    side,
    sessionId,
  }) {
    try {
      this.db
        .prepare(
          `INSERT INTO solana_events
             (ts,sig,wallet,kind,sol_amount,token,mint,dex,side,session_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          ts,
          sig,
          wallet,
          kind,
          solAmount,
          token,
          mint || null,
          dex,
          side || null,
          sessionId || null
        );
      return true;
    } catch {
      return false;
    }
  }

  bumpWallet(wallet, ts, size = 0) {
    if (!wallet) return;
    this.db
      .prepare(
        `INSERT INTO wallet_stats (wallet, hits, size_sum, last_seen)
         VALUES (?,1,?,?)
         ON CONFLICT(wallet) DO UPDATE SET
           hits = hits + 1,
           size_sum = size_sum + excluded.size_sum,
           last_seen = excluded.last_seen`
      )
      .run(wallet, size, ts);
  }

  bumpWalletResult(wallet, win) {
    if (!wallet) return;
    const col = win ? 'wins' : 'losses';
    this.db
      .prepare(`UPDATE wallet_stats SET ${col} = ${col} + 1 WHERE wallet = ?`)
      .run(wallet);
  }

  markSolanaPosted(sig, lane) {
    if (!sig) return;
    const col = lane === 'free' ? 'posted_free' : 'posted_paid';
    this.db.prepare(`UPDATE solana_events SET ${col}=1 WHERE sig=?`).run(sig);
  }

  dueSolanaFree(cutoff, limit = 5) {
    return this.db
      .prepare(
        `SELECT * FROM solana_events WHERE posted_free=0 AND posted_paid=1 AND ts <= ? ORDER BY ts ASC LIMIT ?`
      )
      .all(cutoff, limit);
  }

  topWallets24h(limit = 5) {
    const since = Date.now() - 24 * 3600 * 1000;
    return this.db
      .prepare(
        `SELECT wallet, hits, wins, losses FROM wallet_stats
         WHERE last_seen > ? ORDER BY hits DESC LIMIT ?`
      )
      .all(since, limit);
  }

  recentSimilarCount(module, windowMs = 15 * 60_000) {
    const since = Date.now() - windowMs;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM sessions WHERE module = ? AND observed_at >= ?`
      )
      .get(module, since);
    return row?.c || 0;
  }

  /** Empirical CDF rank of solAmt vs trailing solana_events (0..1). */
  magnitudePercentile(solAmt, lookback = 500) {
    if (!(solAmt > 0)) return 0;
    const rows = this.db
      .prepare(
        `SELECT sol_amount AS a FROM solana_events
         WHERE sol_amount IS NOT NULL
         ORDER BY id DESC LIMIT ?`
      )
      .all(lookback)
      .map((r) => r.a)
      .filter((a) => Number.isFinite(a));
    if (rows.length < 8) {
      // cold start — whale/mega anchors handled by caller
      return null;
    }
    rows.sort((a, b) => a - b);
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid] <= solAmt) lo = mid + 1;
      else hi = mid;
    }
    return lo / rows.length;
  }

  getSession(id) {
    return this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) || null;
  }

  sessionMint(sessionId) {
    const row = this.getSession(sessionId);
    if (!row) return null;
    try {
      const p = JSON.parse(row.payload);
      return p.mint || p.tokenMint || null;
    } catch {
      return null;
    }
  }

  schedulePriceSamples(sessionId, samples) {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO price_samples (session_id, horizon, due_at) VALUES (?, ?, ?)`
    );
    const tx = this.db.transaction((rows) => {
      for (const s of rows) stmt.run(sessionId, s.horizon, s.due_at);
    });
    tx(samples);
  }

  listDuePriceSamples(now, lim = 25) {
    return this.db
      .prepare(
        `SELECT session_id, horizon, due_at FROM price_samples
         WHERE sampled_at IS NULL AND due_at <= ?
         ORDER BY due_at ASC LIMIT ?`
      )
      .all(now, lim);
  }

  markPriceSample(sessionId, horizon, price) {
    this.db
      .prepare(
        `UPDATE price_samples SET sampled_at = ?, price = ? WHERE session_id = ? AND horizon = ?`
      )
      .run(Date.now(), price, sessionId, horizon);
  }

  getPriceSamples(sessionId) {
    return this.db
      .prepare(`SELECT * FROM price_samples WHERE session_id = ?`)
      .all(sessionId);
  }

  insertPoolEvent({ ts, sig, dex, mintA, mintB, sessionId, raw }) {
    try {
      this.db
        .prepare(
          `INSERT INTO pool_events (ts, sig, dex, mint_a, mint_b, session_id, raw_json)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(ts, sig, dex, mintA || null, mintB || null, sessionId || null, raw || null);
      return true;
    } catch {
      return false;
    }
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
