#!/usr/bin/env node
'use strict';
/**
 * Deterministic pipeline replay.
 * Feeds fixture JSONL through MAD-z analyzer and asserts fire count.
 */
const fs = require('fs');
const path = require('path');
const { madZ } = require('../src/sources/RollingMAD');

const fxPath = path.join(__dirname, '..', 'test', 'fixtures', 'prices.jsonl');
if (!fs.existsSync(fxPath)) {
  console.error('missing fixture:', fxPath);
  process.exit(1);
}

const fx = fs.readFileSync(fxPath, 'utf8')
  .trim().split('\n').filter(Boolean).map(JSON.parse);

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
