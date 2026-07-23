CREATE TABLE IF NOT EXISTS alert_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  signal_type   TEXT    NOT NULL,
  symbol        TEXT,
  tier          TEXT    NOT NULL CHECK (tier IN ('public','premium','premium_alpha')),
  conviction    INTEGER,
  payload_json  TEXT    NOT NULL,
  entry_price   REAL,
  degraded      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_alert_ts     ON alert_history(ts DESC);
CREATE INDEX IF NOT EXISTS ix_alert_symts  ON alert_history(symbol, ts DESC);
CREATE INDEX IF NOT EXISTS ix_alert_type   ON alert_history(signal_type, ts DESC);

CREATE TABLE IF NOT EXISTS alert_outcomes (
  alert_id      INTEGER PRIMARY KEY REFERENCES alert_history(id) ON DELETE CASCADE,
  ts_scored     INTEGER NOT NULL,
  p_15m         REAL,
  p_1h          REAL,
  p_4h          REAL,
  p_24h         REAL,
  max_fav_bps   REAL,
  max_adv_bps   REAL,
  hit_positive  INTEGER
);

CREATE TABLE IF NOT EXISTS funnel_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  session_id TEXT    NOT NULL,
  event      TEXT    NOT NULL CHECK (event IN ('view','start','success','failed')),
  variant    TEXT,
  meta_json  TEXT
);
CREATE INDEX IF NOT EXISTS ix_funnel_session ON funnel_events(session_id);
CREATE INDEX IF NOT EXISTS ix_funnel_ts      ON funnel_events(ts DESC);

CREATE TABLE IF NOT EXISTS subscribers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_customer   TEXT    UNIQUE,
  telegram_user_id  INTEGER UNIQUE,
  tier              TEXT    NOT NULL CHECK (tier IN ('premium','premium_alpha')),
  status            TEXT    NOT NULL CHECK (status IN ('active','past_due','canceled')),
  referral_code     TEXT    UNIQUE,
  referred_by       TEXT,
  created_at        INTEGER NOT NULL,
  renews_at         INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sub_status ON subscribers(status);
