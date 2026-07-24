/**
 * HeliusResilientWs — production Solana log feed.
 * - Exponential reconnect with jitter
 * - Silence watchdog (force reconnect if no frames)
 * - Subscription ACK tracking + resubscribe on open
 * - Optional breaker + stats
 */
'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

class HeliusWs extends EventEmitter {
  constructor({
    name = 'helius',
    apiKey,
    log,
    programs = [],
    commitment = 'confirmed',
    silenceMs = 45_000,
    pingMs = 20_000,
    breaker = null,
  }) {
    super();
    this.name = name;
    this.apiKey = apiKey;
    this.log = log;
    this.programs = programs;
    this.commitment = commitment;
    this.silenceMs = silenceMs;
    this.pingMs = pingMs;
    this.breaker = breaker;
    this.ws = null;
    this.stopped = false;
    this.failures = 0;
    this.lastMessageAt = 0;
    this.lastOpenAt = 0;
    this.subIds = new Map(); // program -> subscription id
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.silenceTimer = null;
    this.stats = { opens: 0, frames: 0, logs: 0, reconnects: 0, acks: 0 };
  }

  get url() {
    return `wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.silenceTimer = setInterval(() => this._checkSilence(), 5_000);
    if (this.silenceTimer.unref) this.silenceTimer.unref();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    this._closeSocket();
  }

  status() {
    return {
      name: this.name,
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      failures: this.failures,
      lastMessageAt: this.lastMessageAt || null,
      silentMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null,
      subs: this.subIds.size,
      stats: { ...this.stats },
    };
  }

  connect() {
    if (this.stopped) return;
    if (this.breaker && !this.breaker.allow()) {
      this._scheduleReconnect(this.breaker.retryAfterMs?.() || 5_000);
      return;
    }
    this._closeSocket();
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.breaker?.failure?.(err);
      this.breaker?.fail?.(err);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.failures = 0;
      this.lastOpenAt = Date.now();
      this.lastMessageAt = Date.now();
      this.stats.opens += 1;
      this.breaker?.success?.();
      this.breaker?.ok?.();
      this.log?.info?.(`${this.name} ws open`);
      this.emit('open');
      this._startPing();
      this._subscribeAll();
    });

    this.ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      this.stats.frames += 1;
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch {
        return;
      }
      this._onFrame(msg);
    });

    this.ws.on('close', (code) => {
      this.log?.warn?.(`${this.name} ws close`, { code });
      this.breaker?.failure?.(new Error('ws close'));
      this.breaker?.fail?.();
      this.emit('close', { code });
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.log?.debug?.(`${this.name} ws error`, { error: err.message });
      this.breaker?.failure?.(err);
      this.breaker?.fail?.(err);
    });
  }

  _onFrame(msg) {
    // Subscription ACK: { result: <subId>, id: <program or custom> }
    if (msg.result != null && msg.id != null && !msg.method) {
      this.stats.acks += 1;
      this.subIds.set(String(msg.id), msg.result);
      this.emit('subscribed', { id: msg.id, subId: msg.result });
      return;
    }
    if (msg.method === 'logsNotification' || msg.params?.result?.value) {
      const val = msg.params?.result?.value;
      if (!val) return;
      this.stats.logs += 1;
      this.emit('log', {
        signature: val.signature,
        err: val.err || null,
        logs: val.logs || [],
        subscription: msg.params?.subscription,
      });
    }
  }

  _subscribeAll() {
    this.subIds.clear();
    for (const pid of this.programs) {
      this._send({
        jsonrpc: '2.0',
        id: pid,
        method: 'logsSubscribe',
        params: [{ mentions: [pid] }, { commitment: this.commitment }],
      });
    }
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  _startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, this.pingMs);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  _checkSilence() {
    if (this.stopped || !this.ws) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.lastMessageAt) return;
    const silent = Date.now() - this.lastMessageAt;
    if (silent > this.silenceMs) {
      this.log?.warn?.(`${this.name} silence — forcing reconnect`, { silentMs: silent });
      this.stats.reconnects += 1;
      try {
        this.ws.terminate();
      } catch {
        this._scheduleReconnect();
      }
    }
  }

  _scheduleReconnect(overrideMs) {
    if (this.stopped) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.failures += 1;
    this.stats.reconnects += 1;
    const base = overrideMs ?? Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 5));
    const jitter = Math.floor(Math.random() * 400);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), base + jitter);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  _closeSocket() {
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }

  _clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    this.reconnectTimer = this.pingTimer = this.silenceTimer = null;
  }
}

module.exports = { HeliusWs };
