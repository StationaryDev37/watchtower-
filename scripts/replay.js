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
  process.exit(0);
}, COAL_MS_LOCAL + 2500);
