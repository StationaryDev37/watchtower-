const path = require('path');
const fs = require('fs');

/**
 * better-sqlite3 WAL store with migrations.
 */
class Db {
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
    this.migrate();
    this.log.info('SQLite WAL ready', { path: dbPath });
    return this;
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);
    const applied = new Set(
      this.db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name)
    );
    for (const m of MIGRATIONS) {
      if (applied.has(m.name)) continue;
      const tx = this.db.transaction(() => {
        this.db.exec(m.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
          .run(m.name, Date.now());
      });
      tx();
      this.log.info('Applied migration', { name: m.name });
    }
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    return this.db.exec(sql);
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
}

const MIGRATIONS = [
  {
    name: '001_alert_history',
    sql: `
      CREATE TABLE IF NOT EXISTS alert_history (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        signal_type TEXT NOT NULL,
        symbol TEXT,
        tier TEXT NOT NULL,
        conviction INTEGER,
        payload_json TEXT NOT NULL,
        entry_price REAL,
        degraded INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS ix_alert_ts ON alert_history(ts DESC);
      CREATE INDEX IF NOT EXISTS ix_alert_sym_ts ON alert_history(symbol, ts DESC);
    `,
  },
  {
    name: '002_alert_outcomes',
    sql: `
      CREATE TABLE IF NOT EXISTS alert_outcomes (
        alert_id INTEGER PRIMARY KEY REFERENCES alert_history(id),
        ts_scored INTEGER NOT NULL,
        p_15m REAL, p_1h REAL, p_4h REAL, p_24h REAL,
        max_fav REAL, max_adv REAL,
        hit_positive INTEGER
      );
    `,
  },
  {
    name: '003_funnel_events',
    sql: `
      CREATE TABLE IF NOT EXISTS funnel_events (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        event TEXT NOT NULL,
        variant TEXT,
        meta_json TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_funnel_session ON funnel_events(session_id);
    `,
  },
  {
    name: '004_subscribers',
    sql: `
      CREATE TABLE IF NOT EXISTS subscribers (
        id INTEGER PRIMARY KEY,
        stripe_customer TEXT UNIQUE,
        telegram_user_id INTEGER UNIQUE,
        tier TEXT NOT NULL,
        status TEXT NOT NULL,
        referral_code TEXT UNIQUE,
        referred_by TEXT,
        created_at INTEGER NOT NULL,
        renews_at INTEGER
      );
    `,
  },
];

module.exports = { Db };
