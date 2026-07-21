const path = require('path');
const fs = require('fs');

/**
 * SQLite WAL store — alert history + funnel events on 1 GB Oracle.
 * better-sqlite3 is sync and tiny; millions of rows are fine.
 */
class Store {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.db = null;
  }

  start() {
    const Database = require('better-sqlite3');
    const dbPath = this.config.store.path;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT,
        tier TEXT,
        key TEXT,
        title TEXT,
        body TEXT,
        symbol TEXT,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
      CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);

      CREATE TABLE IF NOT EXISTS funnel (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        event TEXT NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_funnel_ts ON funnel(ts);

      CREATE TABLE IF NOT EXISTS solana_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        sig TEXT UNIQUE,
        wallet TEXT,
        kind TEXT,
        sol_amount REAL,
        token TEXT,
        dex TEXT,
        posted_free INTEGER DEFAULT 0,
        posted_paid INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sol_events_ts ON solana_events(ts);
      CREATE INDEX IF NOT EXISTS idx_sol_events_free ON solana_events(posted_free, ts);

      CREATE TABLE IF NOT EXISTS wallet_stats (
        wallet TEXT PRIMARY KEY,
        hits INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        last_seen INTEGER
      );
    `);
    this.insertAlert = this.db.prepare(
      `INSERT INTO alerts (ts, type, tier, key, title, body, symbol, payload)
       VALUES (@ts, @type, @tier, @key, @title, @body, @symbol, @payload)`
    );
    this.insertFunnel = this.db.prepare(
      `INSERT INTO funnel (ts, event, meta) VALUES (@ts, @event, @meta)`
    );
    this.log.info('SQLite WAL ready', { path: dbPath });
  }

  stop() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
      this.db = null;
    }
  }

  recordAlert(alert) {
    if (!this.db) return;
    try {
      this.insertAlert.run({
        ts: Date.now(),
        type: alert.type || null,
        tier: alert.tier || null,
        key: alert.key || null,
        title: String(alert.title || '').slice(0, 280),
        body: String(alert.body || '').slice(0, 1000),
        symbol: alert.symbol || null,
        payload: JSON.stringify(alert).slice(0, 8000),
      });
    } catch (err) {
      this.log.debug('store.recordAlert failed', { error: err.message });
    }
  }

  recordFunnel(event, meta = {}) {
    if (!this.db) return;
    try {
      this.insertFunnel.run({
        ts: Date.now(),
        event,
        meta: JSON.stringify(meta).slice(0, 2000),
      });
    } catch (err) {
      this.log.debug('store.recordFunnel failed', { error: err.message });
    }
  }

  recentAlerts(limit = 20) {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT ts, type, tier, title, body, symbol FROM alerts ORDER BY id DESC LIMIT ?`
      )
      .all(limit);
  }

  alertCount24h() {
    if (!this.db) return 0;
    const since = Date.now() - 24 * 3600 * 1000;
    const row = this.db.prepare(`SELECT COUNT(*) AS c FROM alerts WHERE ts >= ?`).get(since);
    return row?.c || 0;
  }

  status() {
    return {
      path: this.config.store.path,
      open: Boolean(this.db),
      alerts24h: this.alertCount24h(),
      solanaEvents24h: this.solanaCount24h(),
    };
  }

  ensureSolanaTables() {
    // Created in start(); method exists so signal can assert readiness
    return Boolean(this.db);
  }

  insertSolanaEvent({ ts, sig, wallet, kind, solAmount, token, dex }) {
    if (!this.db) return null;
    try {
      this.db
        .prepare(
          `INSERT INTO solana_events (ts,sig,wallet,kind,sol_amount,token,dex)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run(ts, sig, wallet, kind, solAmount, token, dex);
      return true;
    } catch {
      return false; // duplicate sig
    }
  }

  bumpWallet(wallet, ts) {
    if (!this.db || !wallet) return;
    this.db
      .prepare(
        `INSERT INTO wallet_stats (wallet,hits,last_seen)
         VALUES (?,1,?)
         ON CONFLICT(wallet) DO UPDATE SET
           hits=hits+1, last_seen=excluded.last_seen`
      )
      .run(wallet, ts);
  }

  markSolanaPosted(sig, lane) {
    if (!this.db) return;
    const col = lane === 'free' ? 'posted_free' : 'posted_paid';
    this.db.prepare(`UPDATE solana_events SET ${col}=1 WHERE sig=?`).run(sig);
  }

  dueSolanaFree(cutoff, limit = 5) {
    if (!this.db) return [];
    return this.db
      .prepare(
        `SELECT * FROM solana_events WHERE posted_free=0 AND ts <= ? ORDER BY ts ASC LIMIT ?`
      )
      .all(cutoff, limit);
  }

  topWallets24h(limit = 5) {
    if (!this.db) return [];
    const since = Date.now() - 24 * 3600 * 1000;
    return this.db
      .prepare(
        `SELECT wallet, hits FROM wallet_stats
         WHERE last_seen > ? ORDER BY hits DESC LIMIT ?`
      )
      .all(since, limit);
  }

  solanaCount24h() {
    if (!this.db) return 0;
    const since = Date.now() - 24 * 3600 * 1000;
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM solana_events WHERE ts >= ?`)
      .get(since);
    return row?.c || 0;
  }
}

module.exports = { Store };
