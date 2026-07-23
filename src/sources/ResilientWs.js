const WebSocket = require('ws');

/**
 * Resilient WSS with optional CircuitBreaker hook.
 */
class ResilientWs {
  constructor({ name, url, log, onMessage, onOpen, breaker = null, pingMs = 15000 }) {
    this.name = name;
    this.url = typeof url === 'function' ? url : () => url;
    this.log = log;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.breaker = breaker;
    this.pingMs = pingMs;
    this.ws = null;
    this.stopped = false;
    this.failures = 0;
    this.lastMessageAt = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
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

  status() {
    return {
      name: this.name,
      connected: Boolean(this.ws && this.ws.readyState === WebSocket.OPEN),
      failures: this.failures,
      lastMessageAt: this.lastMessageAt,
      silentMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null,
    };
  }

  connect() {
    if (this.stopped) return;
    if (this.breaker && !this.breaker.allow()) {
      this.scheduleReconnect(this.breaker.retryAfterMs());
      return;
    }
    let url;
    try {
      url = this.url();
      this.ws = new WebSocket(url);
    } catch (err) {
      this.breaker?.failure(err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.failures = 0;
      this.breaker?.success();
      this.log.info(`${this.name} connected`);
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
      try {
        this.onOpen?.(this.ws);
      } catch (err) {
        this.log.warn(`${this.name} onOpen failed`, { error: err.message });
      }
    });

    this.ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        this.onMessage(JSON.parse(text), this.ws);
      } catch (err) {
        this.log.debug(`${this.name} bad message`, { error: err.message });
      }
    });

    this.ws.on('close', () => {
      this.breaker?.failure(new Error('ws close'));
      this.scheduleReconnect();
    });
    this.ws.on('error', (err) => {
      this.log.debug(`${this.name} ws error`, { error: err.message });
      this.breaker?.failure(err);
    });
  }

  scheduleReconnect(overrideMs) {
    if (this.stopped) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.failures += 1;
    const delay =
      overrideMs ?? Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 5));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
    }
  }
}

module.exports = { ResilientWs };
