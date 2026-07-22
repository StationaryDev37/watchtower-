const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ResilientWs } = require('./ResilientWs');
const { madZ } = require('../math/mad');

/**
 * PriceRouter — Binance + Bybit WSS primary, CoinGecko fallback.
 *
 * Spike math (1s resampled window W=300):
 *   med = median(p[t-W..t])
 *   mad = median(|p_i - med|)
 *   z   = 0.6745 * (p_t - med) / mad
 * Fire when |z| ≥ Z_FIRE AND mad/med ≥ NOISE_FLOOR.
 * Volume MAD-z ≥ Z_VOL_FIRE confirms → premium; price-only → public.
 */
class PriceRouter extends EventEmitter {
  constructor(config, log, { breakers } = {}) {
    super();
    this.config = config;
    this.log = log;
    this.breakers = breakers || {};
    this.sockets = [];
    this.prices = new Map(); // symbol -> { price, ts, source, volume1m }
    this.series = new Map(); // symbol -> { prices: number[], volumes: number[], lastSampleTs }
    this.fallbackTimer = null;
    this.evalTimer = null;
    this.stats = { ticks: 0, spikes: 0, fallbackPolls: 0 };
    this.degraded = false;
    this.symbols = [];
  }

  async start() {
    this.symbols = await this.resolveUniverse();
    const silentMs = this.config.price.silentMs;

    if (this.config.price.binanceEnabled) {
      // bookTicker per symbol is quieter than !ticker@arr for 1GB; batch streams
      const chunks = chunk(this.symbols, 40);
      for (const [i, group] of chunks.entries()) {
        const streams = group.map((s) => `${s.toLowerCase()}@bookTicker`).join('/');
        const ws = new ResilientWs({
          name: `binance-price-${i}`,
          url: `wss://fstream.binance.com/stream?streams=${streams}`,
          log: this.log,
          breaker: this.breakers.binance,
          onMessage: (msg) => this.onBinance(msg),
        });
        ws.start();
        this.sockets.push(ws);
      }
    }

    if (this.config.price.bybitEnabled) {
      const ws = new ResilientWs({
        name: 'bybit-price',
        url: 'wss://stream.bybit.com/v5/public/linear',
        log: this.log,
        breaker: this.breakers.bybit,
        onOpen: (sock) => {
          for (const batch of chunk(this.symbols, 10)) {
            sock.send(
              JSON.stringify({
                op: 'subscribe',
                args: batch.map((s) => `tickers.${s}`),
              })
            );
          }
        },
        onMessage: (msg) => this.onBybit(msg),
      });
      ws.start();
      this.sockets.push(ws);
    }

    this.fallbackTimer = setInterval(() => {
      this.pollCoingecko().catch((err) => {
        this.breakers.coingecko?.failure(err);
        this.log.debug('CoinGecko fallback failed', { error: err.message });
      });
    }, this.config.price.fallbackPollSec * 1000);
    if (this.fallbackTimer.unref) this.fallbackTimer.unref();

    this.evalTimer = setInterval(() => this.resampleAndAnalyze(), 1000);
    if (this.evalTimer.unref) this.evalTimer.unref();

    this.silentTimer = setInterval(() => this.checkSilence(silentMs), 2000);
    if (this.silentTimer.unref) this.silentTimer.unref();

    await this.pollCoingecko().catch(() => {});
    this.log.info('PriceRouter started', {
      symbols: this.symbols.length,
      zFire: this.config.price.zFire,
      zVolFire: this.config.price.zVolFire,
    });
  }

  async stop() {
    for (const s of this.sockets) s.stop();
    this.sockets = [];
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    if (this.evalTimer) clearInterval(this.evalTimer);
    if (this.silentTimer) clearInterval(this.silentTimer);
  }

  async resolveUniverse() {
    const configured = this.config.price.symbols;
    if (configured.length && this.config.price.universe !== 'auto') {
      return configured;
    }
    const cachePath = this.config.price.universePath;
    try {
      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (cached.symbols?.length && Date.now() - cached.ts < 24 * 3600 * 1000) {
          return cached.symbols.slice(0, this.config.price.maxSymbols);
        }
      }
    } catch {
      /* ignore */
    }
    // Default liquid universe (USDT perps)
    const defaults = (
      configured.length
        ? configured
        : [
            'BTCUSDT',
            'ETHUSDT',
            'SOLUSDT',
            'BNBUSDT',
            'XRPUSDT',
            'DOGEUSDT',
            'ADAUSDT',
            'AVAXUSDT',
            'LINKUSDT',
            'DOTUSDT',
          ]
    ).slice(0, this.config.price.maxSymbols);
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ ts: Date.now(), symbols: defaults }, null, 2)
      );
    } catch {
      /* ignore */
    }
    return defaults;
  }

  onBinance(msg) {
    const d = msg.data || msg;
    if (!d?.s || d.b == null) return;
    this.setTick(d.s.toUpperCase(), Number(d.b), 'binance', Number(d.B) || 0);
  }

  onBybit(msg) {
    if (!msg.topic?.startsWith('tickers.') || !msg.data) return;
    const d = msg.data;
    const sym = String(d.symbol || '').toUpperCase();
    const px = Number(d.lastPrice || d.bid1Price);
    if (!sym || !Number.isFinite(px)) return;
    this.setTick(sym, px, 'bybit', Number(d.volume24h) || 0);
  }

  setTick(symbol, price, source, volumeHint = 0) {
    if (!Number.isFinite(price) || price <= 0) return;
    const prev = this.prices.get(symbol) || {};
    this.prices.set(symbol, {
      ...prev,
      symbol,
      price,
      source,
      volumeHint,
      ts: Date.now(),
    });
    this.stats.ticks += 1;
    this.emit('tick', { symbol, price, ts: Date.now(), source });
  }

  checkSilence(silentMs) {
    const now = Date.now();
    let anyLive = false;
    for (const s of this.sockets) {
      const st = s.status();
      if (st.connected && st.lastMessageAt && now - st.lastMessageAt < silentMs) {
        anyLive = true;
      }
    }
    const was = this.degraded;
    this.degraded = !anyLive && this.sockets.length > 0;
    if (this.degraded && !was) {
      this.log.warn('PriceRouter degraded — falling back to CoinGecko');
    }
    if (!this.degraded && was) {
      this.log.info('PriceRouter recovered');
    }
  }

  /** 1s resample into rolling windows, then MAD-z spike detection */
  resampleAndAnalyze() {
    const W = this.config.price.windowSec;
    const now = Date.now();
    for (const [symbol, tick] of this.prices) {
      if (!tick.price) continue;
      let ser = this.series.get(symbol);
      if (!ser) {
        ser = { prices: [], volumes: [], lastSampleTs: 0, lastVol: 0 };
        this.series.set(symbol, ser);
      }
      // Approximate 1m volume delta from hint when available
      const volDelta = Math.max(0, (tick.volumeHint || 0) - (ser.lastVol || 0));
      ser.lastVol = tick.volumeHint || ser.lastVol;
      ser.prices.push(tick.price);
      ser.volumes.push(volDelta || tick.price * 0.0001); // tiny placeholder if no vol
      if (ser.prices.length > W) {
        ser.prices.shift();
        ser.volumes.shift();
      }
      if (ser.prices.length < Math.min(60, W)) continue;

      const px = tick.price;
      const { z, med, mad } = madZ(px, ser.prices);
      const noiseOk = med > 0 && mad / med >= this.config.price.noiseFloor;
      const priceFire = noiseOk && Math.abs(z) >= this.config.price.zFire;

      const volZ = madZ(ser.volumes[ser.volumes.length - 1], ser.volumes).z;
      const volFire = Math.abs(volZ) >= this.config.price.zVolFire;

      if (priceFire) {
        const tier = volFire ? 'premium' : 'public';
        this.stats.spikes += 1;
        this.emit('spike', {
          symbol,
          z,
          mad,
          med,
          price: px,
          zVol: volZ,
          tier,
          source: tick.source,
          degraded: this.degraded,
          ts: now,
        });
      } else if (volFire) {
        this.emit('volume-spike', {
          symbol,
          zVol: volZ,
          tier: 'public',
          price: px,
          source: tick.source,
          degraded: this.degraded,
          ts: now,
        });
      }
    }
  }

  async pollCoingecko() {
    const ids = this.config.coins.join(',');
    if (!ids) return;
    const headers = { Accept: 'application/json' };
    if (this.config.coingecko.apiKey) headers['x-cg-demo-api-key'] = this.config.coingecko.apiKey;
    const { data } = await axios.get(`${this.config.coingecko.baseUrl}/coins/markets`, {
      params: {
        vs_currency: 'usd',
        ids,
        price_change_percentage: '1h,24h',
      },
      headers,
      timeout: 20000,
    });
    this.breakers.coingecko?.success();
    this.stats.fallbackPolls += 1;
    for (const coin of data) {
      const symbol = coinIdToUsdt(coin.id, coin.symbol);
      const prev = this.prices.get(symbol) || {};
      const age = prev.ts ? Date.now() - prev.ts : Infinity;
      if (age > 5000 || this.degraded) {
        this.setTick(symbol, Number(coin.current_price), 'coingecko');
      }
      const cur = this.prices.get(symbol) || {};
      this.prices.set(symbol, {
        ...cur,
        id: coin.id,
        name: coin.name,
        change1h: Number(coin.price_change_percentage_1h_in_currency),
        change24h: Number(coin.price_change_percentage_24h_in_currency),
      });
    }
  }

  get(symbol) {
    return this.prices.get(String(symbol).toUpperCase()) || null;
  }

  isLive(maxAgeMs = 15_000) {
    const now = Date.now();
    for (const p of this.prices.values()) {
      if (p.source !== 'coingecko' && p.ts && now - p.ts < maxAgeMs) return true;
    }
    return false;
  }

  status() {
    return {
      live: this.isLive(),
      degraded: this.degraded,
      symbols: this.prices.size,
      ticks: this.stats.ticks,
      spikes: this.stats.spikes,
      fallbackPolls: this.stats.fallbackPolls,
      sockets: this.sockets.map((s) => s.status()),
    };
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function coinIdToUsdt(id, symbol) {
  const map = {
    bitcoin: 'BTCUSDT',
    ethereum: 'ETHUSDT',
    solana: 'SOLUSDT',
    binancecoin: 'BNBUSDT',
    ripple: 'XRPUSDT',
  };
  if (map[id]) return map[id];
  return `${String(symbol || id).toUpperCase()}USDT`;
}

module.exports = { PriceRouter };
