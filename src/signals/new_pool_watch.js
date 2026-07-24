/**
 * new_pool_watch — Raydium / Orca pool creation edge.
 * Subscribes to the same AMM programs; fires when initialize logs appear,
 * then enriches via Helius parsed tx. Premium-alpha when both mints resolve.
 */
'use strict';

const axios = require('axios');
const { SignalPlugin } = require('./base');
const { HeliusWs } = require('../sources/HeliusWs');
const { SigCache } = require('../sources/SigCache');
const { SignalSession } = require('../core/session');

const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const ORCA_WHIRL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const INIT_PATTERNS = [
  /initialize2/i,
  /initializepool/i,
  /init_pc_amount/i,
  /initialize\b/i,
  /createmultipletoken/i,
];

class NewPoolWatchSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'new_pool_watch';
    this.ws = null;
    this.dispatch = null;
    this.settler = null;
    this.degraded = false;
    this.seen = 0;
    this.alerts = 0;
    this.inspecting = 0;
    this.sigCache = new SigCache(4000);
  }

  async start() {
    if (!this.config.helius?.apiKey) {
      this.log.info('new_pool_watch idle — set HELIUS_KEY');
      return;
    }
    const programs = [RAYDIUM_AMM, ORCA_WHIRL];
    if (this.config.helius.watchCpmm !== false) programs.push(RAYDIUM_CPMM);

    this.ws = new HeliusWs({
      name: 'helius-pools',
      apiKey: this.config.helius.apiKey,
      log: this.log,
      programs,
      silenceMs: Number(process.env.HELIUS_SILENCE_MS || 60_000),
    });
    this.ws.on('open', () => {
      this.degraded = false;
    });
    this.ws.on('close', () => {
      this.degraded = true;
    });
    this.ws.on('log', (ev) => this.onLog(ev));
    this.ws.start();
    this.log.info('new_pool_watch started', { programs: programs.length });
  }

  async stop() {
    this.ws?.stop();
    this.ws = null;
  }

  status() {
    return {
      running: Boolean(this.ws),
      degraded: this.degraded,
      seen: this.seen,
      alerts: this.alerts,
      inspecting: this.inspecting,
      socket: this.ws?.status?.(),
    };
  }

  onLog(ev) {
    if (!ev?.signature || ev.err) return;
    const logs = ev.logs || [];
    if (!logs.some((l) => INIT_PATTERNS.some((re) => re.test(l)))) return;
    if (!this.sigCache.check(ev.signature)) return;
    this.seen += 1;
    if (this.inspecting >= (this.config.helius.maxInflight || 4)) return;
    this.inspect(ev.signature, logs).catch((err) =>
      this.log.debug('pool inspect failed', { error: err.message })
    );
  }

  async inspect(sig, logs) {
    this.inspecting += 1;
    try {
      const tx = await this.fetchTx(sig);
      if (!tx) return;
      const dex = classifyDex(tx, logs);
      const mints = extractMints(tx);
      if (mints.length < 1) return;

      const mintA = mints[0];
      const mintB = mints[1] || null;
      const session = new SignalSession({
        module: 'new_pool_watch',
        payload: {
          sig,
          dex,
          mint: mintA,
          mintA,
          mintB,
          mints,
          kind: 'POOL_CREATE',
          side: 'BUY', // treat as speculative long bias for settlement
          logs: (logs || []).slice(0, 8),
        },
      });

      const recent = this.history?.recentSimilarCount?.('new_pool_watch', 10 * 60_000) || 0;
      session.markScored({
        confidence: mints.length >= 2 ? 0.9 : 0.7,
        magnitude: 0.75,
        novelty: Math.max(0, 1 - recent / 15),
        observedAt: session.observed_at,
      });
      this.history?.upsertSession?.(session);
      if (!session.score.publishPaid) return;

      const inserted = this.history?.insertPoolEvent?.({
        ts: session.observed_at,
        sig,
        dex,
        mintA,
        mintB,
        sessionId: session.id,
        raw: JSON.stringify({ mints }).slice(0, 2000),
      });
      if (inserted === false) return;

      this.alerts += 1;
      const formatted = this.format(session);
      if (this.dispatch) await this.dispatch.publish(session, formatted);
      else {
        await this.emit({ ...formatted.paid, coalesceMs: 0 });
        if (formatted.x) await this.emit({ ...formatted.x, coalesceMs: 0 });
        session.markPublished();
        this.history?.upsertSession?.(session);
      }
      this.settler?.schedule?.(session);

      this.log.info('ALERT new_pool_watch', {
        dex,
        mint: short(mintA),
        score: session.score.total,
        session: session.id,
      });
    } finally {
      this.inspecting -= 1;
    }
  }

  async fetchTx(sig) {
    const key = this.config.helius.apiKey;
    try {
      const { data } = await axios.post(
        `https://api.helius.xyz/v0/transactions/?api-key=${key}`,
        { transactions: [sig] },
        { timeout: 12_000 }
      );
      return Array.isArray(data) ? data[0] : data;
    } catch {
      return null;
    }
  }

  format(session) {
    const p = session.payload;
    const title = `NEW POOL · ${p.dex}`;
    const body = `New ${p.dex} pool. mint ${short(p.mintA)}${
      p.mintB ? ` / ${short(p.mintB)}` : ''
    }.`;
    const url = `https://solscan.io/tx/${p.sig}`;
    const fields = [
      { label: 'DEX', value: p.dex },
      { label: 'Mint A', value: p.mintA },
      { label: 'Mint B', value: p.mintB || 'n/a' },
      { label: 'Score', value: String(session.score?.total ?? '') },
    ];
    const base = {
      type: 'new_pool_watch',
      signal_type: 'new_pool_watch.create',
      symbol: 'SOL',
      title,
      body,
      fields,
      url,
      sig: p.sig,
      mint: p.mintA,
      features: {
        x1: session.score?.confidence || 0,
        x2: session.score?.novelty || 0,
        x3: session.score?.total || 0,
      },
    };
    return {
      paid: {
        ...base,
        tier: 'premium_alpha',
        lane: 'premium_alpha',
        channels: ['telegram'],
        key: `pool:paid:${p.sig}`,
        coalesceKey: `pool:paid:${p.sig}`,
      },
      free: session.score?.publishFree
        ? {
            ...base,
            tier: 'public',
            channels: ['telegram'],
            key: `pool:free:${p.sig}`,
            coalesceKey: `pool:free:${p.sig}`,
            title: `${title} (delayed)`,
            body: `${body} Free delayed — Premium saw it first.`,
          }
        : null,
      x: {
        ...base,
        tier: 'public',
        channels: ['twitter'],
        key: `pool:x:${p.sig}`,
        coalesceKey: `pool:x:${p.sig}`,
        body: `${title}: ${short(p.mintA)}. ${url}`,
      },
    };
  }
}

function classifyDex(tx, logs) {
  const blob = `${tx?.source || ''} ${(logs || []).join(' ')}`.toUpperCase();
  if (blob.includes('RAYDIUM') || blob.includes(RAYDIUM_AMM.slice(0, 8).toUpperCase())) {
    return 'RAYDIUM';
  }
  if (blob.includes('ORCA') || blob.includes('WHIRL')) return 'ORCA';
  return String(tx?.source || 'UNKNOWN').toUpperCase();
}

function extractMints(tx) {
  const out = new Set();
  const tokenTransfers = tx.tokenTransfers || [];
  for (const t of tokenTransfers) {
    if (t.mint) out.add(t.mint);
  }
  for (const bal of tx.accountData || []) {
    for (const tb of bal.tokenBalanceChanges || []) {
      if (tb.mint) out.add(tb.mint);
    }
  }
  // Filter known junk / wrapped SOL if we have alternatives
  const WSOL = 'So11111111111111111111111111111111111111112';
  const arr = [...out];
  const nonSol = arr.filter((m) => m !== WSOL);
  return nonSol.length ? nonSol : arr;
}

function short(w) {
  return w ? `${String(w).slice(0, 4)}..${String(w).slice(-4)}` : '?';
}

module.exports = { NewPoolWatchSignal };
