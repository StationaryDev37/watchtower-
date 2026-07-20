const http = require('http');
const { URL } = require('url');

/**
 * HttpSurface — same process serves health, paywall, checkout, and Stripe webhooks.
 * No separate frontend deploy required for day-1 revenue.
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
        routes: ['/', '/health', '/upgrade', '/success', '/webhook/stripe'],
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
      return this.json(res, 200, this.healthPayload());
    }

    if (req.method === 'GET' && path === '/') {
      return this.html(res, landingPage(this.config));
    }

    if (req.method === 'GET' && path === '/upgrade') {
      return this.html(res, upgradePage(this.config));
    }

    if (req.method === 'POST' && path === '/api/checkout') {
      const body = await readJson(req);
      const session = await this.deps.revenue.createCheckoutSession(body);
      return this.json(res, 200, { url: session.url, id: session.id });
    }

    if (req.method === 'GET' && path === '/checkout') {
      const session = await this.deps.revenue.createCheckoutSession({
        email: url.searchParams.get('email') || undefined,
        telegramHandle: url.searchParams.get('tg') || undefined,
      });
      res.writeHead(303, { Location: session.url });
      res.end();
      return;
    }

    if (req.method === 'GET' && path === '/success') {
      return this.html(res, successPage(this.config));
    }

    if (req.method === 'POST' && path === '/webhook/stripe') {
      const raw = await readRaw(req);
      const sig = req.headers['stripe-signature'];
      const event = this.deps.revenue.constructWebhookEvent(raw, sig);
      const result = await this.deps.revenue.handleWebhook(event);
      return this.json(res, 200, { received: true, result });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  healthPayload() {
    return {
      status: 'ok',
      service: 'watchtower',
      architecture: 'single-source-framework',
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
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

function landingPage(config) {
  const brand = escapeHtml(config.brand);
  const price = config.stripe.monthlyUsd;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${brand} — crypto alerts that pay for themselves</title>
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
    .meta { margin-top:2.5rem; padding-top:1.25rem; border-top:1px solid var(--line);
      color:var(--muted); font-size:.9rem; }
  </style>
</head>
<body>
  <main>
    <h1 class="brand">${brand}</h1>
    <p>Free market alerts on Telegram &amp; X. Premium whale signals unlock the same day you deploy — one codebase, one process, zero cloud bill on Oracle Always Free.</p>
    <div class="cta">
      <a class="btn primary" href="/checkout">Start Premium — $${price}/mo</a>
      <a class="btn ghost" href="/upgrade">How it works</a>
    </div>
    <p class="meta">Single-source framework · signals → channels → Stripe · revenue from day 1</p>
  </main>
</body>
</html>`;
}

function upgradePage(config) {
  const brand = escapeHtml(config.brand);
  const price = config.stripe.monthlyUsd;
  const invite = config.telegram.inviteLink
    ? `<p>After payment you receive the private channel invite automatically.</p>`
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
    a.btn { display:inline-flex; margin-top:1rem; background:#2dd4bf; color:#04201c;
      text-decoration:none; font-weight:700; padding:.9rem 1.2rem; border-radius:4px; }
    code { color:#2dd4bf; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${brand} Premium</h1>
    <ul>
      <li>Whale transfer alerts (Telegram private)</li>
      <li>Stronger volatility signals earlier</li>
      <li>Same oracle — paid tier, not a second product</li>
    </ul>
    ${invite}
    <a class="btn" href="/checkout">Pay $${price}/mo with Stripe</a>
  </div>
</body>
</html>`;
}

function successPage(config) {
  const brand = escapeHtml(config.brand);
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
  </style>
</head>
<body>
  <div>
    <h1>Premium unlocked</h1>
    ${invite}
    <p><a href="/">Back to ${brand}</a></p>
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
