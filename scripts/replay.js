#!/usr/bin/env node
/**
 * Validation harness — MAD-z, dedup, coalesce, breaker state machine.
 * Runs in ~4s. Exit 0 on pass.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { madZ } = require('../src/math/mad');
const { AlertBus } = require('../src/bus/AlertBus');
const { CircuitBreaker } = require('../src/ops/CircuitBreaker');
const { ConvictionScorer, defaultPriors, irls } = require('../src/bus/ConvictionScorer');

async function main() {
  // (a) MAD-z reference
  const fixturePath = path.join(__dirname, '../test/fixtures/prices.jsonl');
  if (fs.existsSync(fixturePath)) {
    const lines = fs.readFileSync(fixturePath, 'utf8').trim().split('\n');
    for (const line of lines) {
      const row = JSON.parse(line);
      const r = madZ(row.x, row.window);
      assert.ok(Math.abs(r.z - row.z) < 1e-9, `z mismatch ${r.z} vs ${row.z}`);
      assert.ok(Math.abs(r.med - row.med) < 1e-9, 'med mismatch');
      assert.ok(Math.abs(r.mad - row.mad) < 1e-9, 'mad mismatch');
    }
  } else {
    const w = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const r = madZ(9, w);
    assert.ok(Math.abs(r.z - 1.349) < 1e-9);
  }
  console.log('ok mad-z');

  // (b) dedup 100%
  const config = {
    dryRun: true,
    alertCooldownSec: 0,
    bus: { coalesceMs: 0, dedupMs: 5000, tgGlobalRate: 25 },
    conviction: { enabled: false },
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const bus = new AlertBus(config, log);
  bus.onAlert(async () => ({ sent: true }));
  await bus.publish({ type: 't', title: 'A', body: 'b', tier: 'public', key: 'k1' });
  await bus.publish({ type: 't', title: 'A', body: 'b', tier: 'public', key: 'k1' });
  assert.strictEqual(bus.stats.deduped, 1);
  assert.strictEqual(bus.stats.delivered, 1);
  console.log('ok dedup');

  // (c) coalesce 100%
  const bus2 = new AlertBus(
    { ...config, bus: { coalesceMs: 30, dedupMs: 0, tgGlobalRate: 25 } },
    log
  );
  bus2.onAlert(async () => ({ sent: true }));
  await bus2.publish({
    type: 't',
    source: 'a',
    coalesceKey: 'c',
    title: 'C',
    body: 'x',
    tier: 'premium',
  });
  await bus2.publish({
    type: 't',
    source: 'b',
    coalesceKey: 'c',
    title: 'C',
    body: 'longer body here',
    tier: 'premium',
  });
  await sleep(80);
  assert.strictEqual(bus2.stats.coalesced, 1);
  assert.ok(bus2.stats.delivered >= 1);
  console.log('ok coalesce');

  // (d) breaker open/half-open/close
  const br = new CircuitBreaker('test', log, {
    consecutiveLimit: 3,
    baseOpenMs: 50,
    maxOpenMs: 200,
  });
  assert.strictEqual(br.allow(), true);
  br.failure(new Error('1'));
  br.failure(new Error('2'));
  br.failure(new Error('3'));
  assert.strictEqual(br.state, 'open');
  assert.strictEqual(br.allow(), false);
  await sleep(60);
  assert.strictEqual(br.allow(), true); // half-open probe
  br.success();
  assert.strictEqual(br.state, 'closed');
  console.log('ok breaker');

  // (e) conviction priors score in range
  const scorer = new ConvictionScorer(
    { conviction: { enabled: true, path: path.join(__dirname, '../data/conviction.json'), minOutcomes: 200 } },
    log
  );
  scorer.model = defaultPriors();
  const scored = scorer.score({
    features: { z: 4, zVol: 5, funding_dev: 2, liq_asym: 1 },
    coalesced: true,
  });
  assert.ok(scored.conviction >= 1 && scored.conviction <= 5);
  console.log('ok conviction', scored.conviction, scored.meta.stars);

  // (f) IRLS sanity on separable data
  const X = [
    [1, 0],
    [1, 1],
    [1, 2],
    [1, 3],
  ];
  const y = [0, 0, 1, 1];
  const beta = irls(X, y, 20);
  assert.ok(Number.isFinite(beta[0]) && Number.isFinite(beta[1]));
  console.log('ok irls');

  console.log('REPLAY_OK');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
