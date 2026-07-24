-- Multi-horizon price samples for real settlement (15m / 1h / 24h)
CREATE TABLE IF NOT EXISTS price_samples (
  session_id  TEXT NOT NULL,
  horizon     TEXT NOT NULL CHECK (horizon IN ('pub','15m','1h','24h')),
  due_at      INTEGER NOT NULL,
  sampled_at  INTEGER,
  price       REAL,
  PRIMARY KEY (session_id, horizon),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_price_samples_due
  ON price_samples(due_at) WHERE sampled_at IS NULL;

CREATE TABLE IF NOT EXISTS pool_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  sig         TEXT UNIQUE,
  dex         TEXT,
  mint_a      TEXT,
  mint_b      TEXT,
  session_id  TEXT,
  raw_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_pool_events_ts ON pool_events(ts DESC);
