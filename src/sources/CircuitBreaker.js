/**
 * EventEmitter circuit breaker for source-owned sockets (Commit B).
 * Framework ops breaker remains in src/ops/CircuitBreaker.js.
 */
'use strict';

const { EventEmitter } = require('events');

class CircuitBreaker extends EventEmitter {
  constructor(
    name,
    {
      windowMs = 30_000,
      minSamples = 10,
      errorRate = 0.5,
      consecErrs = 5,
      openMs = 5_000,
      maxOpenMs = 5 * 60_000,
    } = {}
  ) {
    super();
    this.name = name;
    this.cfg = { windowMs, minSamples, errorRate, consecErrs, openMs, maxOpenMs };
    this.state = 'closed';
    this.samples = [];
    this.consec = 0;
    this.nextOpenMs = openMs;
    this.openedAt = 0;
  }

  _gc(now) {
    const cutoff = now - this.cfg.windowMs;
    while (this.samples.length && this.samples[0].ts < cutoff) this.samples.shift();
  }

  ok() {
    const now = Date.now();
    this.samples.push({ ts: now, ok: true });
    this.consec = 0;
    this._gc(now);
    if (this.state === 'half-open') this._close();
  }

  success() {
    this.ok();
  }

  fail(err) {
    const now = Date.now();
    this.samples.push({ ts: now, ok: false });
    this.consec += 1;
    this._gc(now);
    if (this.state === 'closed' && this._shouldTrip()) this._open(err);
    else if (this.state === 'half-open') this._open(err);
  }

  failure(err) {
    this.fail(err);
  }

  _shouldTrip() {
    if (this.consec >= this.cfg.consecErrs) return true;
    if (this.samples.length < this.cfg.minSamples) return false;
    const fails = this.samples.filter((s) => !s.ok).length;
    return fails / this.samples.length >= this.cfg.errorRate;
  }

  _open() {
    this.state = 'open';
    this.openedAt = Date.now();
    this.emit('open', { name: this.name, openMs: this.nextOpenMs });
    setTimeout(() => this._halfOpen(), this.nextOpenMs).unref?.();
    this.nextOpenMs = Math.min(this.nextOpenMs * 2, this.cfg.maxOpenMs);
  }

  _halfOpen() {
    this.state = 'half-open';
    this.emit('half-open', { name: this.name });
  }

  _close() {
    this.state = 'closed';
    this.consec = 0;
    this.nextOpenMs = this.cfg.openMs;
    this.emit('close', { name: this.name });
  }

  allow() {
    return this.state !== 'open';
  }

  status() {
    return { name: this.name, state: this.state, openMs: this.nextOpenMs };
  }
}

module.exports = { CircuitBreaker };
