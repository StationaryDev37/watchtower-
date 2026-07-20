const WebSocket = require('ws');

/**
 * Resilient WSS client with exponential backoff + degraded flag.
 * Circuit breaker: after N failures, stay quiet until cooldown.
 */
class ResilientWs {
  constructor({ name, url, log, onMessage, onOpen, pingMs = 15000 }) {
    this.name = name;
    this.url = typeof url === 'function' ? url : () => url;
    this.log = log;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.pingMs = pingMs;
    this.ws = null;
    this.stopped = false;
    this.failures = 0;
    this.degraded = false;
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
      degraded: this.degraded,
      failures: this.failures,
      lastMessageAt: this.lastMessageAt,
    };
  }

  connect() {
    if (this.stopped) return;
    const url = this.url();
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.log.warn(`${this.name} ws construct failed`, { error: err.message });
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.failures = 0;
      this.degraded = false;
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
      if (this.onOpen) {
        try {
          this.onOpen(this.ws);
        } catch (err) {
          this.log.warn(`${this.name} onOpen failed`, { error: err.message });
        }
      }
    });

    this.ws.on('message', (data) => {
      this.lastMessageAt = Date.now();
      try {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        const msg = JSON.parse(text);
        this.onMessage(msg, this.ws);
      } catch (err) {
        this.log.debug(`${this.name} bad message`, { error: err.message });
      }
    });

    this.ws.on('close', () => this.scheduleReconnect());
    this.ws.on('error', (err) => {
      this.log.debug(`${this.name} ws error`, { error: err.message });
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.failures += 1;
    this.degraded = true;
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 5));
    this.log.warn(`${this.name} reconnect in ${delay}ms`, { failures: this.failures });
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
