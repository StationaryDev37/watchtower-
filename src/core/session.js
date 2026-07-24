/**
 * SignalSession — OBSERVED → SCORED → PUBLISHED → SETTLED
 */
'use strict';

const crypto = require('crypto');
const { score: buildScore } = require('./score');

const STATES = Object.freeze(['OBSERVED', 'SCORED', 'PUBLISHED', 'SETTLED']);

class SignalSession {
  constructor({
    id = crypto.randomUUID(),
    module,
    payload,
    observedAt = Date.now(),
    state = 'OBSERVED',
  }) {
    if (!module) throw new Error('SignalSession requires module');
    this.id = id;
    this.module = module;
    this.state = state;
    this.observed_at = observedAt;
    this.scored_at = null;
    this.published_at = null;
    this.settled_at = null;
    this.payload = payload || {};
    this.score = null;
    this.outcome = null;
    this.receipts = [];
  }

  observe(payloadPatch = {}) {
    this.payload = { ...this.payload, ...payloadPatch };
    this.state = 'OBSERVED';
    if (!this.observed_at) this.observed_at = Date.now();
    return this;
  }

  markScored(parts) {
    this.score = buildScore({
      ...parts,
      observedAt: this.observed_at,
    });
    this.scored_at = Date.now();
    this.state = 'SCORED';
    return this;
  }

  markPublished() {
    this.published_at = Date.now();
    this.state = 'PUBLISHED';
    return this;
  }

  markSettled(outcome) {
    this.outcome = outcome;
    this.settled_at = Date.now();
    this.state = 'SETTLED';
    return this;
  }

  addReceipt(channel, messageId = null) {
    const r = { channel, posted_at: Date.now(), message_id: messageId };
    this.receipts.push(r);
    return r;
  }

  toRow() {
    return {
      id: this.id,
      module: this.module,
      state: this.state,
      observed_at: this.observed_at,
      scored_at: this.scored_at,
      published_at: this.published_at,
      settled_at: this.settled_at,
      payload: JSON.stringify(this.payload),
      score_json: this.score ? JSON.stringify(this.score) : null,
      outcome_json: this.outcome ? JSON.stringify(this.outcome) : null,
    };
  }

  static fromRow(row) {
    const s = new SignalSession({
      id: row.id,
      module: row.module,
      payload: safeJson(row.payload, {}),
      observedAt: row.observed_at,
      state: row.state,
    });
    s.scored_at = row.scored_at;
    s.published_at = row.published_at;
    s.settled_at = row.settled_at;
    s.score = safeJson(row.score_json, null);
    s.outcome = safeJson(row.outcome_json, null);
    return s;
  }
}

function safeJson(s, fallback) {
  if (s == null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

module.exports = { SignalSession, STATES };
