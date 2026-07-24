/**
 * Dispatch — paid TG + X immediate; free TG after PAID_LAG_MS.
 */
'use strict';

class Dispatch {
  constructor(config, log, { bus, history } = {}) {
    this.config = config;
    this.log = log;
    this.bus = bus;
    this.history = history;
    this.pendingFree = []; // { readyAt, session, alert }
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.flushFree().catch(() => {}), 5_000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Publish paid/X now; queue free if score allows.
   * @param {import('./session').SignalSession} session
   * @param {{ paid: object, free: object, x: object }} formatted
   */
  async publish(session, formatted) {
    const score = session.score || {};
    const lagMs = this.config.helius?.freeLagMs ?? Number(process.env.PAID_LAG_MS ?? 300_000);

    if (score.publishPaid !== false) {
      if (formatted.paid) {
        await this.bus.publish({
          ...formatted.paid,
          session_id: session.id,
          signal_type: formatted.paid.signal_type || `${session.module}.alert`,
          coalesceMs: 0,
        });
        session.addReceipt('tg_paid');
        this.history?.addReceipt?.(session.id, 'tg_paid');
      }
      if (formatted.x) {
        await this.bus.publish({
          ...formatted.x,
          session_id: session.id,
          signal_type: formatted.x.signal_type || `${session.module}.x`,
          coalesceMs: 0,
        });
        session.addReceipt('x');
        this.history?.addReceipt?.(session.id, 'x');
      }
    }

    if (score.publishFree && formatted.free) {
      this.pendingFree.push({
        readyAt: Date.now() + lagMs,
        sessionId: session.id,
        alert: {
          ...formatted.free,
          session_id: session.id,
          delayed: true,
          coalesceMs: 0,
        },
      });
    }

    session.markPublished();
    this.history?.upsertSession?.(session);
    return session;
  }

  async flushFree() {
    const now = Date.now();
    const due = [];
    const keep = [];
    for (const item of this.pendingFree) {
      if (item.readyAt <= now) due.push(item);
      else keep.push(item);
    }
    this.pendingFree = keep;
    for (const item of due) {
      try {
        await this.bus.publish(item.alert);
        this.history?.addReceipt?.(item.sessionId, 'tg_free');
        this.history?.markSolanaPosted?.(item.alert.sig, 'free');
      } catch (err) {
        this.log?.error?.('free dispatch failed', { error: err.message });
      }
    }
  }

  status() {
    return { pendingFree: this.pendingFree.length };
  }
}

module.exports = { Dispatch };
