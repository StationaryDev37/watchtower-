/**
 * Single SQLite handle for the whole process. WAL, versioned SQL migrations, sync API.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

class Db {
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.db = null;
    this.DB_PATH = null;
  }

  start() {
    const Database = require('better-sqlite3');
    this.DB_PATH =
      process.env.DB_PATH ||
      this.config?.store?.path ||
      path.join(process.cwd(), 'data', 'watchtower.db');
    fs.mkdirSync(path.dirname(this.DB_PATH), { recursive: true });

    this.db = new Database(this.DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 134217728'); // 128 MiB
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);
    this.applyMigrations();
    this.log?.info?.('SQLite WAL ready', { path: this.DB_PATH });
    return this;
  }

  applyMigrations() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return;
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    const applied = new Set(
      this.db.prepare('SELECT version FROM _migrations').all().map((r) => r.version)
    );
    const run = this.db.transaction((file) => {
      const version = parseInt(file.slice(0, 4), 10);
      if (applied.has(version)) return;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      this.db.exec(sql);
      this.db
        .prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)')
        .run(version, Date.now());
      this.log?.info?.('Applied migration', { version, file });
    });
    for (const f of files) run(f);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  close() {
    if (!this.db) return;
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }

  stop() {
    this.close();
  }
}

module.exports = { Db };
