/**
 * Settler — measure price outcome after publish (Jupiter when mint known).
 */
'use strict';

const axios = require('axios');

class Settler {
  constructor(config, log, { history } = {}) {
    this.config = config;
    this.log = log;
    this.history = history;
    this.timer = null;
    this.outcomeWindowMs = Number(process.env.OUTCOME_WINDOW_MS ?? 15 * 60_000);
  }

  start() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 60_000);
    if (this.timer.unref) this.timer.unref();
    this.log?.info?.('Settler armed', { windowMs: this.outcomeWindowMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (!this.history?.listSessionsForSettle) return;
    const cutoff = Date.now() - this.outcomeWindowMs;
    const rows = this.history.listSessionsForSettle(cutoff, 20);
    for (const row of rows) {
      try {
        await this.settleRow(row);
      } catch (err) {
        this.log?.debug?.('settle failed', { id: row.id, error: err.message });
      }
    }
  }

  async settleRow(row) {
    const { SignalSession } = require('./session');
    const session = SignalSession.fromRow(row);
    const payload = session.payload || {};
    const mint = payload.mint || payload.tokenMint || null;
    const t0 = session.published_at || session.observed_at;
    const p0 = mint ? await jupPrice(mint) : null;
    // Best-effort: sample now as ~15m proxy when we only settle after window
    const p15 = p0;
    const p1h = p0;
    const p24 = null;
    const side = String(payload.side || '').toUpperCase();
    const dir = side === 'BUY' || side === 'BUY_SOL' ? 1 : side === 'SELL' ? -1 : 0;
    let hit = null;
    if (dir && p0 != null && p1h != null) {
      hit = dir * (p1h - p0) > 0 ? 1 : 0;
    }
    const outcome = {
      price_at_pub: p0,
      price_at_15m: p15,
      price_at_1h: p1h,
      price_at_24h: p24,
      hit,
    };
    session.markSettled(outcome);
    this.history.recordOutcomeSession(session);
    if (payload.wallet && hit != null) {
      this.history.bumpWalletResult(payload.wallet, hit === 1);
    }
    this.log?.info?.('session settled', {
      id: session.id,
      module: session.module,
      hit,
    });
  }
}

async function jupPrice(mint) {
  if (!mint || mint.length < 20) return null;
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

module.exports = { Settler, jupPrice };
