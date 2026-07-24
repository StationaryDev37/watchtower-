#!/usr/bin/env node
'use strict';
/**
 * Deterministic pipeline replay:
 *  1) MAD-z price fixture fire count
 *  2) AlertBus dedup + symbol coalesce (Commit B)
 */
const fs = require('fs');
const path = require('path');
const { madZ } = require('../src/sources/RollingMAD');
const { AlertBus } = require('../src/bus/AlertBus');

// --- 1) MAD-z replay ---------------------------------------------------
const fxPath = path.join(__dirname, '..', 'test', 'fixtures', 'prices.jsonl');
if (!fs.existsSync(fxPath)) {
  console.error('missing fixture:', fxPath);
  process.exit(1);
}

const fx = fs
  .readFileSync(fxPath, 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse);

const W = 300_000;
const bySym = new Map();
let fires = 0;
const lastFire = new Map();
const COOLDOWN = 60_000;

for (const t of fx) {
  const win = bySym.get(t.symbol) || [];
  bySym.set(t.symbol, win);
  const last = win.length ? win[win.length - 1].ts : 0;
  if (t.ts - last >= 1000) win.push({ ts: t.ts, v: t.price });
  while (win.length && win[0].ts < t.ts - W) win.shift();
  if (win.length < 30) continue;
  const arr = win.map((x) => x.v);
  const { z, mad, med } = madZ(arr, t.price);
  if (!(mad / med >= 0.0005)) continue;
  if (Math.abs(z) >= 3.5) {
    const lf = lastFire.get(t.symbol) || 0;
    if (t.ts - lf < COOLDOWN) continue;
    lastFire.set(t.symbol, t.ts);
    fires++;
  }
}

const expected = Number(process.env.REPLAY_EXPECTED_FIRES ?? 3);
if (fires !== expected) {
  console.error(`replay: expected ${expected} fires, got ${fires}`);
  process.exit(1);
}
console.log(`replay OK — fires=${fires}`);

// --- 2) AlertBus dedup + coalesce --------------------------------------
const COAL_MS_LOCAL = Number(process.env.COALESCE_WINDOW_MS ?? 5_000);

const bus = new AlertBus(
  { bus: { coalesceMs: COAL_MS_LOCAL, dedupMs: 3_000, tgGlobalRate: 25, maxQueue: 500 }, alertCooldownSec: 0 },
  { info() {}, warn() {}, error() {} }
);

let delivered = 0;
let coalesced = 0;
bus.on('deliver', (env) => {
  delivered += 1;
  if (env.features?.x7 === 1) coalesced += 1;
});

const base = {
  ts: Date.now(),
  signal_type: 'market.spike',
  type: 'market',
  symbol: 'BTCUSDT',
  tier: 'public',
  payload: { price: 100 },
  features: { x1: 4, x2: 0, x7: 0 },
  title: 'BTC UP',
  body: 'spike',
};

bus.emit('alert', base);
bus.emit('alert', base); // dedup within DEDUP_MS

setTimeout(() => {
  bus.emit('alert', {
    ...base,
    signal_type: 'funding.divergence',
    type: 'funding',
    tier: 'premium',
    payload: { deviation: 2.3 },
    features: { x3: 2.3 },
    title: 'BTC funding rich',
    body: 'divergence',
  });
}, 1000);

setTimeout(() => {
  bus.stop();
  if (delivered !== 1) {
    console.error('bus replay: expected 1 delivery, got', delivered);
    process.exit(2);
  }
  if (coalesced !== 1) {
    console.error('bus replay: expected coalesced=1, got', coalesced);
    process.exit(3);
  }
  console.log('bus replay OK — deliver=1 coalesced=1');

  // --- 3) Score vector -------------------------------------------------
  const {
    score,
    magnitudeFromSol,
    PUBLISH_THRESHOLD_PAID,
    PUBLISH_THRESHOLD_FREE,
  } = require('../src/core/score');
  const s = score({
    confidence: 0.95,
    magnitude: magnitudeFromSol(800, 500, 2000),
    novelty: 0.9,
    observedAt: Date.now(),
  });
  if (!(s.total >= PUBLISH_THRESHOLD_PAID)) {
    console.error('score replay: expected paid publish', s);
    process.exit(4);
  }
  const weak = score({
    confidence: 0.5,
    magnitude: 0.2,
    novelty: 0.2,
    urgency: 0.2,
  });
  if (weak.publishFree) {
    console.error('score replay: weak signal should not clear free threshold', weak);
    process.exit(5);
  }
  console.log(
    `score replay OK — total=${s.total} paid≥${PUBLISH_THRESHOLD_PAID} free≥${PUBLISH_THRESHOLD_FREE}`
  );

  // --- 4) Session + settlement + percentile smoke ---------------------------
  const { Db } = require('../src/store/db');
  const { History } = require('../src/store/history');
  const { SignalSession } = require('../src/core/session');
  const { Settler } = require('../src/core/settler');
  const { SigCache } = require('../src/sources/SigCache');
  const { HeliusWs } = require('../src/sources/HeliusWs');
  const { NewPoolWatchSignal } = require('../src/signals/new_pool_watch');

  const cache = new SigCache(3);
  if (!cache.check('a') || cache.check('a') || !cache.check('b') || !cache.check('c')) {
    console.error('sigcache basic failed');
    process.exit(7);
  }
  cache.check('d'); // evicts a
  if (cache.has('a')) {
    console.error('sigcache LRU eviction failed');
    process.exit(8);
  }
  console.log('sigcache OK');

  if (typeof HeliusWs !== 'function') {
    console.error('HeliusWs missing');
    process.exit(9);
  }

  const tmp = path.join('/tmp', `wt-session-${process.pid}.db`);
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  const db = new Db({ store: { path: tmp } }, { info() {}, warn() {} }).start();
  const hist = new History(db, { info() {} }).start();

  // seed events for percentile
  for (let i = 1; i <= 20; i++) {
    hist.insertSolanaEvent({
      ts: Date.now() - i * 1000,
      sig: `sig${i}`,
      wallet: `W${i}`,
      kind: 'SWAP',
      solAmount: i * 100,
      token: 'TOK',
      mint: 'So11111111111111111111111111111111111111112',
      dex: 'RAYDIUM',
      side: 'BUY',
    });
  }
  const pct = hist.magnitudePercentile(1500);
  if (!(pct > 0.5 && pct < 1)) {
    console.error('percentile unexpected', pct);
    process.exit(10);
  }
  console.log('percentile OK —', pct.toFixed(3));

  const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const sess = new SignalSession({
    module: 'solana_whale',
    payload: { sig: 'abc', wallet: 'Wallet111', solAmount: 1500, side: 'BUY', mint },
  });
  sess.markScored({ confidence: 0.9, magnitude: pct, novelty: 0.8 });
  sess.markPublished();
  hist.upsertSession(sess);
  hist.addReceipt(sess.id, 'tg_paid');
  hist.bumpWallet('Wallet111', Date.now(), 1500);

  const settler = new Settler({}, { info() {}, debug() {} }, { history: hist });
  settler.schedule(sess);
  const samples = hist.getPriceSamples(sess.id);
  if (samples.length !== 4) {
    console.error('expected 4 horizons, got', samples.length);
    process.exit(11);
  }
  const due = hist.listDuePriceSamples(Date.now() + 1000, 10);
  if (!due.some((d) => d.horizon === 'pub')) {
    console.error('pub sample not due');
    process.exit(12);
  }
  hist.markPriceSample(sess.id, 'pub', 1.23);
  hist.markPriceSample(sess.id, '15m', 1.3);
  hist.markPriceSample(sess.id, '1h', 1.4);
  // finalize via private path
  settler._writeOutcome(sess.id, {
    pub: { price: 1.23, sampled_at: Date.now() },
    '15m': { price: 1.3, sampled_at: Date.now() },
    '1h': { price: 1.4, sampled_at: Date.now() },
  }, hist.getSession(sess.id));
  const settled = hist.getSession(sess.id);
  if (settled.state !== 'SETTLED') {
    console.error('expected SETTLED', settled.state);
    process.exit(13);
  }
  const outcome = JSON.parse(settled.outcome_json);
  if (outcome.hit !== 1) {
    console.error('BUY + up price should hit=1', outcome);
    process.exit(14);
  }
  console.log('settlement OK — hit=1 bps=', outcome.bps);

  const poolOk = hist.insertPoolEvent({
    ts: Date.now(),
    sig: 'poolsig1',
    dex: 'RAYDIUM',
    mintA: mint,
    mintB: 'So11111111111111111111111111111111111111112',
    sessionId: sess.id,
    raw: '{}',
  });
  if (!poolOk) {
    console.error('pool insert failed');
    process.exit(15);
  }
  const pool = new NewPoolWatchSignal({ helius: { apiKey: null } }, { info() {}, warn() {} }, null);
  if (pool.name !== 'new_pool_watch') {
    console.error('new_pool_watch name mismatch');
    process.exit(16);
  }
  console.log('new_pool_watch plugin OK');

  const n = hist.recentSimilarCount('solana_whale', 60_000);
  if (n < 1) {
    console.error('session smoke: expected recentSimilarCount>=1');
    process.exit(6);
  }
  db.close();
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* ignore */
  }
  console.log('session smoke OK');
  process.exit(0);
}, COAL_MS_LOCAL + 2500);
