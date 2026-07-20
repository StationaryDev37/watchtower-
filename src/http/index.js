const http = require('http');
const { URL } = require('url');

/**
 * HttpSurface — health, paywall, multi-rail checkout, webhooks.
 * Framing: market data / entertainment — not financial advice (Stripe risk).
 */
class HttpSurface {
  constructor(config, log, deps) {
    this.config = config;
    this.log = log;
    this.deps = deps;
    this.server = null;
    this.startedAt = Date.now();
  }

  start() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log.error('HTTP error', { error: err.message, path: req.url });
        if (!res.headersSent) {
          res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    });

    this.server.listen(this.config.healthPort, '0.0.0.0', () => {
      this.log.info(`HTTP surface on :${this.config.healthPort}`, {
        routes: [
          '/',
          '/health',
          '/upgrade',
          '/checkout',
          '/checkout/crypto',
          '/success',
          '/webhook/stripe',
          '/webhook/crypto',
        ],
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/health' || path === '/status')) {
      const payload = this.healthPayload();
      const code = payload.httpStatus || 200;
      return this.json(res, code, payload);
    }

    if (req.method === 'GET' && path === '/') {
      this.deps.store?.recordFunnel('landing_view');
      return this.html(
        res,
        landingPage(this.config, {
          recent: this.deps.store?.recentAlerts(8) || [],
          alerts24h: this.deps.store?.alertCount24h?.() || 0,
        })
      );
    }

    if (req.method === 'GET' && path === '/upgrade') {
      this.deps.store?.recordFunnel('upgrade_view');
      return this.html(res, upgradePage(this.config));
    }

    if (req.method === 'POST' && path === '/api/checkout') {
      const body = await readJson(req);
      this.deps.store?.recordFunnel('checkout_start', { rail: body.rail || 'stripe' });
      const session = await this.deps.revenue.createCheckoutSession(body);
      return this.json(res, 200, session);
    }

    if (req.method === 'GET' && path === '/checkout') {
      this.deps.store?.recordFunnel('checkout_start', { rail: url.searchParams.get('rail') || 'stripe' });
      const session = await this.deps.revenue.createCheckoutSession({
        email: url.searchParams.get('email') || undefined,
        telegramHandle: url.searchParams.get('tg') || undefined,
        rail: url.searchParams.get('rail') || undefined,
      });
      res.writeHead(303, { Location: session.url });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/checkout/crypto') {
      this.deps.store?.recordFunnel('checkout_start', { rail: 'crypto' });
      const session = await this.deps.revenue.createCheckoutSession({
        email: url.searchParams.get('email') || undefined,
        telegramHandle: url.searchParams.get('tg') || undefined,
        rail: 'crypto',
      });
      res.writeHead(303, { Location: session.url });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/success') {
      this.deps.store?.recordFunnel('checkout_success');
      return this.html(res, successPage(this.config));
    }

    if (req.method === 'POST' && path === '/webhook/stripe') {
      const raw = await readRaw(req);
      const result = await this.deps.revenue.handleStripeWebhook(raw, req.headers);
      return this.json(res, 200, { received: true, result });
    }

    if (req.method === 'POST' && path === '/webhook/crypto') {
      const raw = await readRaw(req);
      const result = await this.deps.revenue.handleCryptoWebhook(raw, req.headers);
      return this.json(res, 200, { received: true, result });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  healthPayload() {
    const health = this.deps.health?.() || { ok: true, httpStatus: 200 };
    return {
      status: health.ok ? 'ok' : 'degraded',
      httpStatus: health.httpStatus || (health.ok ? 200 : 503),
      service: 'watchtower',
      architecture: 'single-source-v2',
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      critical: health.critical,
      degraded: health.degraded,
      memory: {
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        watchdog: this.deps.watchdog?.status?.(),
      },
      priceFeed: this.deps.priceFeed?.status?.(),
      store: this.deps.store?.status?.(),
      signals: this.deps.signals.status(),
      channels: this.deps.channels.status(),
      revenue: this.deps.revenue.getStats(),
      bus: this.deps.bus.getStats(),
    };
  }

  json(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  html(res, body) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

function landingPage(config, extra = {}) {
  const brand = escapeHtml(config.brand);
  const price = config.stripe.monthlyUsd;
  const disclaimer = escapeHtml(config.legal.disclaimer);
  const cryptoEnabled = Boolean(
    config.cryptoRail.apiKey || config.cryptoRail.payUrl || config.cryptoRail.walletAddress
  );
  const recent = (extra.recent || [])
    .map(
      (a) =>
        `<li><span>${escapeHtml(a.type || '')}</span> ${escapeHtml(a.title || '')}</li>`
    )
    .join('');
  const proof =
    extra.alerts24h > 0
      ? `<p class="proof">${extra.alerts24h} alerts in the last 24h</p><ul class="feed">${recent}</ul>`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brand} — market data alerts</title>
  <style>
    :root { --bg:#071018; --ink:#e8f1f8; --muted:#8aa0b2; --accent:#2dd4bf; --line:#1c2a36; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; color:var(--ink);
      background: radial-gradient(1200px 600px at 10% -10%, #123047 0%, transparent 55%),
                  radial-gradient(900px 500px at 100% 0%, #0d3d36 0%, transparent 50%),
                  var(--bg); min-height:100vh; }
    main { max-width:720px; margin:0 auto; padding:12vh 1.5rem 4rem; }
    .brand { font-family:"IBM Plex Serif", Georgia, serif; font-size:clamp(2.6rem,8vw,4.2rem);
      letter-spacing:-0.03em; margin:0 0 .6rem; line-height:1; }
    p { color:var(--muted); font-size:1.15rem; line-height:1.55; max-width:36rem; }
    .cta { display:flex; flex-wrap:wrap; gap:.75rem; margin-top:1.75rem; }
    a.btn { appearance:none; border:0; text-decoration:none; display:inline-flex; align-items:center;
      padding:.9rem 1.25rem; border-radius:4px; font-weight:600; font-size:1rem; }
    a.primary { background:var(--accent); color:#04201c; }
    a.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); }
    .meta, .legal { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--line);
      color:var(--muted); font-size:.85rem; line-height:1.45; max-width:40rem; }
    .proof { margin-top:2rem; font-size:.95rem; }
    .feed { list-style:none; padding:0; margin:.5rem 0 0; color:var(--muted); font-size:.9rem; }
    .feed li { padding:.35rem 0; border-bottom:1px solid var(--line); }
    .feed span { color:var(--accent); text-transform:uppercase; font-size:.7rem; margin-right:.5rem; }
  </style>
</head>
<body>
  <main>
    <h1 class="brand">${brand}</h1>
    <p>Cross-venue funding, liquidation cascades, and sub-second market moves — delivered before the free bots refresh CoinGecko.</p>
    <div class="cta">
      <a class="btn primary" href="/checkout">Premium — $${price}/mo</a>
      ${cryptoEnabled ? `<a class="btn ghost" href="/checkout/crypto">Pay with crypto</a>` : ''}
      <a class="btn ghost" href="/upgrade">How it works</a>
    </div>
    ${proof}
    <p class="meta">v2 · WSS prices · edge signals · SQLite history · Stripe + crypto</p>
    <p class="legal">${disclaimer}</p>
  </main>
</body>
</html>`;
}

function upgradePage(config) {
  const brand = escapeHtml(config.brand);
  const price = config.stripe.monthlyUsd;
  const disclaimer = escapeHtml(config.legal.disclaimer);
  const cryptoEnabled = Boolean(
    config.cryptoRail.apiKey || config.cryptoRail.payUrl || config.cryptoRail.walletAddress
  );
  const invite = config.telegram.inviteLink
    ? `<p>After payment you receive the private channel invite.</p>`
    : `<p>Set <code>TELEGRAM_PREMIUM_INVITE_LINK</code> so buyers get instant access.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upgrade — ${brand}</title>
  <style>
    body { margin:0; font-family:"IBM Plex Sans",sans-serif; background:#071018; color:#e8f1f8;
      min-height:100vh; display:grid; place-items:center; padding:2rem; }
    .card { max-width:480px; width:100%; }
    h1 { font-family:"IBM Plex Serif", Georgia, serif; font-size:2rem; margin:0 0 .75rem; }
    p, li { color:#8aa0b2; line-height:1.5; }
    a.btn { display:inline-flex; margin:.5rem .5rem 0 0; background:#2dd4bf; color:#04201c;
      text-decoration:none; font-weight:700; padding:.9rem 1.2rem; border-radius:4px; }
    a.ghost { background:transparent; color:#e8f1f8; border:1px solid #1c2a36; }
    code { color:#2dd4bf; }
    .legal { margin-top:1.5rem; font-size:.8rem; color:#8aa0b2; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${brand} Premium</h1>
    <ul>
      <li>Private Telegram market-data feed</li>
      <li>Whale / stronger-move alerts</li>
      <li>Same oracle — paid tier, not a second product</li>
    </ul>
    ${invite}
    <a class="btn" href="/checkout">Card · $${price}/mo</a>
    ${cryptoEnabled ? `<a class="btn ghost" href="/checkout/crypto">Crypto</a>` : ''}
    <p class="legal">${disclaimer}</p>
  </div>
</body>
</html>`;
}

function successPage(config) {
  const brand = escapeHtml(config.brand);
  const disclaimer = escapeHtml(config.legal.shortDisclaimer);
  const invite = config.telegram.inviteLink
    ? `<p><a href="${escapeHtml(config.telegram.inviteLink)}">Join the premium Telegram channel →</a></p>`
    : `<p>Check your email / DM for the private channel invite.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>You're in — ${brand}</title>
  <style>
    body { margin:0; font-family:"IBM Plex Sans",sans-serif; background:#071018; color:#e8f1f8;
      min-height:100vh; display:grid; place-items:center; padding:2rem; text-align:center; }
    h1 { font-family:"IBM Plex Serif", Georgia, serif; }
    a { color:#2dd4bf; }
    .legal { color:#8aa0b2; font-size:.85rem; margin-top:1.5rem; }
  </style>
</head>
<body>
  <div>
    <h1>Premium unlocked</h1>
    ${invite}
    <p><a href="/">Back to ${brand}</a></p>
    <p class="legal">${disclaimer}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { HttpSurface };
