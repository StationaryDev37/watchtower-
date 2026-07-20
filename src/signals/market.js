const axios = require('axios');

class MarketSignal {
  constructor(config, log, bus) {
    this.name = 'market';
    this.config = config;
    this.log = log;
    this.bus = bus;
    this.timer = null;
    this.lastPrices = new Map();
    this.lastVolumes = new Map();
    this.lastPollAt = null;
    this.pollCount = 0;
  }

  async start() {
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log.error('Market tick failed', { error: err.message }));
    }, this.config.pollIntervalSec * 1000);
    this.log.info('Market signal started', { coins: this.config.coins });
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      running: Boolean(this.timer),
      lastPollAt: this.lastPollAt,
      pollCount: this.pollCount,
      tracked: this.lastPrices.size,
    };
  }

  headers() {
    const h = { Accept: 'application/json' };
    if (this.config.coingecko.apiKey) h['x-cg-demo-api-key'] = this.config.coingecko.apiKey;
    return h;
  }

  async tick() {
    const ids = this.config.coins.join(',');
    const { data } = await axios.get(`${this.config.coingecko.baseUrl}/coins/markets`, {
      params: {
        vs_currency: 'usd',
        ids,
        order: 'market_cap_desc',
        per_page: 50,
        page: 1,
        sparkline: false,
        price_change_percentage: '1h,24h',
      },
      headers: this.headers(),
      timeout: 20000,
    });

    this.lastPollAt = new Date().toISOString();
    this.pollCount += 1;

    for (const coin of data) {
      await this.evaluate(coin);
    }
  }

  async evaluate(coin) {
    const id = coin.id;
    const price = Number(coin.current_price);
    const vol = Number(coin.total_volume);
    const change1h = Number(coin.price_change_percentage_1h_in_currency);
    const change24h = Number(coin.price_change_percentage_24h_in_currency);
    const prevPrice = this.lastPrices.get(id);
    const prevVol = this.lastVolumes.get(id);

    this.lastPrices.set(id, price);
    this.lastVolumes.set(id, vol);
    if (prevPrice == null) return;

    const movePct = ((price - prevPrice) / prevPrice) * 100;
    const absMove = Math.abs(movePct);
    const volSpike = prevVol > 0 ? ((vol - prevVol) / prevVol) * 100 : 0;
    const hitMove = absMove >= this.config.thresholds.priceMovePct;
    const hitVol = volSpike >= this.config.thresholds.volumeSpikePct;
    const hitHourly = Math.abs(change1h) >= this.config.thresholds.priceMovePct;
    if (!hitMove && !hitVol && !hitHourly) return;

    const strong =
      Math.abs(change1h) >= this.config.thresholds.priceMovePct * 2 ||
      absMove >= this.config.thresholds.priceMovePct * 2;

    const direction = movePct >= 0 || change1h >= 0 ? 'UP' : 'DOWN';
    const title = `${coin.symbol.toUpperCase()} ${direction} ${fmtPct(hitHourly ? change1h : movePct)}`;
    const body = `${coin.name} trades at $${fmtUsd(price)}. 24h: ${fmtPct(change24h)}.`;

    await this.bus.publish({
      type: 'market',
      // Strong moves → premium tier (paid channel + free teaser)
      tier: strong ? 'premium' : 'public',
      key: `market:${id}:${direction}`,
      title,
      body,
      url: `https://www.coingecko.com/en/coins/${id}`,
      symbol: coin.symbol.toUpperCase(),
      fields: [
        { label: 'Price', value: `$${fmtUsd(price)}` },
        { label: '1h', value: fmtPct(change1h) },
        { label: '24h', value: fmtPct(change24h) },
        { label: 'Volume', value: `$${fmtUsd(vol)}` },
        ...(hitVol ? [{ label: 'Vol spike', value: fmtPct(volSpike) }] : []),
      ],
    });
  }
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return 'n/a';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(4);
}

module.exports = { MarketSignal };
