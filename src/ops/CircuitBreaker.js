/**
 * CircuitBreaker — closed → open → half-open → closed
 * Open on: 5 consecutive errors OR >50% error rate over 30s (min 10 samples)
 * Open duration: 5s × 2^n, capped 5min
 */
class CircuitBreaker {
  constructor(name, log, opts = {}) {
    this.name = name;
    this.log = log;
    this.consecutiveLimit = opts.consecutiveLimit || 5;
    this.windowMs = opts.windowMs || 30_000;
    this.minSamples = opts.minSamples || 10;
    this.errorRate = opts.errorRate || 0.5;
    this.baseOpenMs = opts.baseOpenMs || 5000;
    this.maxOpenMs = opts.maxOpenMs || 300_000;
    this.state = 'closed';
    this.consecutive = 0;
    this.openCount = 0;
    this.openedAt = 0;
    this.openMs = this.baseOpenMs;
    this.events = []; // {t, ok}
    this.halfOpenProbe = false;
  }

  allow() {
    this._expire();
    if (this.state === 'closed') return true;
    if (this.state === 'open') return false;
    // half-open: single probe
    if (this.halfOpenProbe) return false;
    this.halfOpenProbe = true;
    return true;
  }

  retryAfterMs() {
    if (this.state !== 'open') return 1000;
    return Math.max(0, this.openMs - (Date.now() - this.openedAt));
  }

  success() {
    this._record(true);
    this.consecutive = 0;
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.openCount = 0;
      this.openMs = this.baseOpenMs;
      this.halfOpenProbe = false;
      this.log?.info?.(`breaker ${this.name} closed`);
    } else if (this.state === 'closed') {
      this.halfOpenProbe = false;
    }
  }

  /** Alias used by PriceRouter / Commit A call sites */
  ok() {
    this.success();
  }

  failure(err) {
    this._record(false);
    this.consecutive += 1;
    if (this.state === 'half-open') {
      this._trip();
      return;
    }
    if (this.state === 'closed' && this._shouldOpen()) {
      this._trip();
      this.log?.warn?.(`breaker ${this.name} open`, {
        error: err?.message,
        consecutive: this.consecutive,
      });
    }
  }

  /** Alias used by PriceRouter / Commit A call sites */
  fail(err) {
    this.failure(err);
  }

  _shouldOpen() {
    if (this.consecutive >= this.consecutiveLimit) return true;
    const now = Date.now();
    const window = this.events.filter((e) => now - e.t <= this.windowMs);
    if (window.length < this.minSamples) return false;
    const fails = window.filter((e) => !e.ok).length;
    return fails / window.length > this.errorRate;
  }

  _trip() {
    this.state = 'open';
    this.openedAt = Date.now();
    this.openCount += 1;
    this.openMs = Math.min(this.maxOpenMs, this.baseOpenMs * 2 ** (this.openCount - 1));
    this.halfOpenProbe = false;
  }

  _expire() {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.openMs) {
      this.state = 'half-open';
      this.halfOpenProbe = false;
    }
  }

  _record(ok) {
    const now = Date.now();
    this.events.push({ t: now, ok });
    this.events = this.events.filter((e) => now - e.t <= this.windowMs);
  }

  status() {
    this._expire();
    return {
      name: this.name,
      state: this.state,
      consecutive: this.consecutive,
      openMs: this.openMs,
    };
  }
}

module.exports = { CircuitBreaker };
