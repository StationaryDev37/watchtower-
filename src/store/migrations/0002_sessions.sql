-- Commit: SignalSession lifecycle + solana whale moat tables
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  module        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('OBSERVED','SCORED','PUBLISHED','SETTLED')),
  observed_at   INTEGER NOT NULL,
  scored_at     INTEGER,
  published_at  INTEGER,
  settled_at    INTEGER,
  payload       TEXT NOT NULL,
  score_json    TEXT,
  outcome_json  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_module_state ON sessions(module, state);
CREATE INDEX IF NOT EXISTS idx_sessions_observed ON sessions(observed_at DESC);

CREATE TABLE IF NOT EXISTS receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,
  posted_at   INTEGER NOT NULL,
  message_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_session ON receipts(session_id);

CREATE TABLE IF NOT EXISTS wallet_stats (
  wallet     TEXT PRIMARY KEY,
  hits       INTEGER DEFAULT 0,
  size_sum   REAL DEFAULT 0,
  wins       INTEGER DEFAULT 0,
  losses     INTEGER DEFAULT 0,
  last_seen  INTEGER
);

CREATE TABLE IF NOT EXISTS outcomes (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  price_at_pub   REAL,
  price_at_15m   REAL,
  price_at_1h    REAL,
  price_at_24h   REAL,
  hit            INTEGER
);

CREATE TABLE IF NOT EXISTS solana_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER,
  sig          TEXT UNIQUE,
  wallet       TEXT,
  kind         TEXT,
  sol_amount   REAL,
  token        TEXT,
  mint         TEXT,
  dex          TEXT,
  side         TEXT,
  session_id   TEXT,
  posted_free  INTEGER DEFAULT 0,
  posted_paid  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sol_events_ts ON solana_events(ts);
CREATE INDEX IF NOT EXISTS idx_sol_events_free ON solana_events(posted_free, ts);
