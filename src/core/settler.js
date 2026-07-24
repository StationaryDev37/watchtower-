/**
 * Settler — real multi-horizon Jupiter price sampling.
 * On publish: schedule pub / 15m / 1h / 24h samples.
 * Tick fills due samples; marks SETTLED when 1h is in (24h updates asynchronously).
 */
'use strict';

const axios = require('axios');

const HORIZONS = [
  { name: 'pub', offsetMs: 0 },
  { name: '15m', offsetMs: 15 * 60_000 },
  { name: '1h', offsetMs: 60 * 60_000 },
  { name: '24h', offsetMs: 24 * 60 * 60_000 },
];

class Settler {
  constructor(config, log, { history } = {}) {
    this.config = config;
    this.log = log;
    this.history = history;
    this.timer = null;
    this.inFlight = new Set();
    this.tickMs = Number(process.env.SETTLER_TICK_MS ?? 30_000);
    this.maxPerTick = Number(process.env.SETTLER_MAX_PER_TICK ?? 25);
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    if (this.timer.unref) this.timer.unref();
    this.log?.info?.('Settler armed', { tickMs: this.tickMs, horizons: HORIZONS.map((h) => h.name) });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Call immediately after a session is PUBLISHED. */
  schedule(session) {
    if (!this.history?.schedulePriceSamples) return;
    const mint = session.payload?.mint || session.payload?.tokenMint;
    if (!mint || String(mint).length < 20) return;
    const t0 = session.published_at || Date.now();
    this.history.schedulePriceSamples(
      session.id,
      HORIZONS.map((h) => ({ horizon: h.name, due_at: t0 + h.offsetMs }))
    );
    // Sample pub ASAP (don't wait for tick)
    this._sampleOne(session.id, 'pub', mint).catch(() => {});
  }

  async tick() {
    if (!this.history?.listDuePriceSamples) return;
    const due = this.history.listDuePriceSamples(Date.now(), this.maxPerTick);
    for (const row of due) {
      const key = `${row.session_id}:${row.horizon}`;
      if (this.inFlight.has(key)) continue;
      this.inFlight.add(key);
      try {
        const mint = this.history.sessionMint?.(row.session_id);
        if (!mint) {
          this.history.markPriceSample(row.session_id, row.horizon, null);
          continue;
        }
        await this._sampleOne(row.session_id, row.horizon, mint);
        if (row.horizon === '1h' || row.horizon === '15m') {
          await this._maybeFinalize(row.session_id);
        }
      } catch (err) {
        this.log?.debug?.('sample failed', { key, error: err.message });
      } finally {
        this.inFlight.delete(key);
      }
    }
  }

  async _sampleOne(sessionId, horizon, mint) {
    const price = await jupPrice(mint);
    this.history.markPriceSample(sessionId, horizon, price);
    return price;
  }

  async _maybeFinalize(sessionId) {
    const samples = this.history.getPriceSamples(sessionId);
    const by = Object.fromEntries(samples.map((s) => [s.horizon, s]));
    // Finalize when 1h sampled (or 15m if 1h still pending after long wait — prefer 1h)
    if (!by['1h']?.sampled_at) return;
    const row = this.history.getSession?.(sessionId);
    if (!row || row.state === 'SETTLED') {
      // Still allow 24h update into outcomes
      if (by['24h']?.sampled_at) this._writeOutcome(sessionId, by, row);
      return;
    }
    this._writeOutcome(sessionId, by, row);
  }

  _writeOutcome(sessionId, by, row) {
    const { SignalSession } = require('./session');
    if (!row) return;
    const session = SignalSession.fromRow(row);
    const payload = session.payload || {};
    const p0 = by.pub?.price ?? null;
    const p15 = by['15m']?.price ?? null;
    const p1h = by['1h']?.price ?? null;
    const p24 = by['24h']?.price ?? null;
    const side = String(payload.side || '').toUpperCase();
    const dir = side === 'BUY' || side === 'BUY_SOL' ? 1 : side === 'SELL' ? -1 : 0;
    let hit = null;
    const ref = p1h ?? p15;
    if (dir && p0 != null && ref != null && p0 > 0) {
      hit = dir * (ref - p0) > 0 ? 1 : 0;
    }
    const bps =
      p0 != null && ref != null && p0 > 0 ? Math.round(((ref - p0) / p0) * 10_000) : null;
    const outcome = {
      price_at_pub: p0,
      price_at_15m: p15,
      price_at_1h: p1h,
      price_at_24h: p24,
      hit,
      bps,
    };
    const firstSettle = session.state !== 'SETTLED';
    if (firstSettle) session.markSettled(outcome);
    else session.outcome = outcome;
    this.history.recordOutcomeSession(session);
    if (firstSettle && payload.wallet && hit != null) {
      this.history.bumpWalletResult(payload.wallet, hit === 1);
    }
    this.log?.info?.('session settled', {
      id: session.id,
      module: session.module,
      hit,
      bps,
      firstSettle,
    });
  }

  status() {
    return {
      inFlight: this.inFlight.size,
      tickMs: this.tickMs,
    };
  }
}

async function jupPrice(mint) {
  if (!mint || String(mint).length < 20) return null;
  try {
    const { data } = await axios.get('https://api.jup.ag/price/v2', {
      params: { ids: mint },
      timeout: 8_000,
      headers: { Accept: 'application/json' },
    });
    const px = data?.data?.[mint]?.price;
    if (Number.isFinite(Number(px))) return Number(px);
  } catch {
    /* fall through to legacy */
  }
  try {
    const { data } = await axios.get('https://price.jup.ag/v6/price', {
      params: { ids: mint },
      timeout: 8_000,
    });
    const px = data?.data?.[mint]?.price;
    return Number.isFinite(Number(px)) ? Number(px) : null;
  } catch {
    return null;
  }
}

module.exports = { Settler, jupPrice, HORIZONS };
