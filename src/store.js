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
    };
  }
}

module.exports = { Store };
