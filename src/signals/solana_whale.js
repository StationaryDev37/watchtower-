/**
 * solana_whale — production Helius Raydium/Orca whale edge.
 * Hardened WS, sig LRU, rolling magnitude percentile, SignalSession + real settlement.
 */
'use strict';

const axios = require('axios');
const { SignalPlugin } = require('./base');
const { HeliusWs } = require('../sources/HeliusWs');
const { SigCache } = require('../sources/SigCache');
const { SignalSession } = require('../core/session');
const { magnitudeFromSol } = require('../core/score');

const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const ORCA_WHIRL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

class SolanaWhaleSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'solana_whale';
    this.ws = null;
    this.digestTimer = null;
    this.dispatch = null;
    this.settler = null;
    this.degraded = false;
    this.seen = 0;
    this.alerts = 0;
    this.inspecting = 0;
    this.dropped = 0;
    this.sigCache = new SigCache(Number(process.env.SOL_SIG_CACHE || 8000));
    this.queue = [];
    this.pumping = false;
  }

  async start() {
    if (!this.config.helius?.apiKey) {
      this.log.info('solana_whale idle — set HELIUS_KEY to enable');
      return;
    }

    this.ws = new HeliusWs({
      name: 'helius-whale',
      apiKey: this.config.helius.apiKey,
      log: this.log,
      programs: [RAYDIUM_AMM, ORCA_WHIRL],
      silenceMs: Number(process.env.HELIUS_SILENCE_MS || 45_000),
    });
    this.ws.on('open', () => {
      this.degraded = false;
    });
    this.ws.on('close', () => {
      this.degraded = true;
    });
    this.ws.on('log', (ev) => {
      if (!ev?.signature || ev.err) return;
      if (!this.sigCache.check(ev.signature)) return;
      this.seen += 1;
      this.enqueue(ev.signature);
    });
    this.ws.start();

    this.digestTimer = setInterval(() => {
      this.postDigest().catch((err) =>
        this.log.error('digest failed', { error: err.message })
      );
    }, this.config.helius.digestMs);
    if (this.digestTimer.unref) this.digestTimer.unref();

    this.log.info('solana_whale started', {
      whaleSol: this.config.helius.whaleSol,
      megaSol: this.config.helius.megaSol,
      freeLagMs: this.config.helius.freeLagMs,
    });
  }

  async stop() {
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.ws?.stop();
    this.ws = null;
    this.queue = [];
  }

  status() {
    return {
      running: Boolean(this.ws),
      degraded: this.degraded,
      seen: this.seen,
      alerts: this.alerts,
      inspecting: this.inspecting,
      dropped: this.dropped,
      queued: this.queue.length,
      sigCache: this.sigCache.size(),
      socket: this.ws?.status?.(),
    };
  }

  enqueue(sig) {
    const maxQ = Number(process.env.HELIUS_INSPECT_QUEUE || 200);
    if (this.queue.length >= maxQ) {
      this.dropped += 1;
      this.queue.shift(); // drop oldest under pressure
    }
    this.queue.push(sig);
    this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const maxInflight = this.config.helius.maxInflight || 4;
      while (this.queue.length && this.inspecting < maxInflight) {
        const sig = this.queue.shift();
        this.inspect(sig).catch((err) =>
          this.log.debug('inspect failed', { error: err.message })
        );
      }
    } finally {
      this.pumping = false;
      if (this.queue.length && this.inspecting < (this.config.helius.maxInflight || 4)) {
        setImmediate(() => this.pump());
      }
    }
  }

  async inspect(sig) {
    this.inspecting += 1;
    try {
      const tx = await this.fetchParsedTx(sig);
      if (!tx) return;

      const swap = tx.events?.swap;
      if (!swap) return;

      const solIn = Number(swap.nativeInput?.amount || 0) / 1e9;
      const solOut = Number(swap.nativeOutput?.amount || 0) / 1e9;
      const solAmt = Math.max(solIn, solOut);
      if (!(solAmt >= this.config.helius.whaleSol)) return;

      const wallet = tx.feePayer;
      const dex = classifyDex(tx);
      const mintOut = swap.tokenOutputs?.[0]?.mint || '';
      const mintIn = swap.tokenInputs?.[0]?.mint || '';
      // Prefer non-SOL / non-stable as the "token" of interest when buying with SOL
      const mint = solIn >= solOut ? mintOut || mintIn : mintIn || mintOut;
      const token = mint ? mint.slice(0, 8) : 'SOL pair';
      const side = solIn >= solOut ? 'BUY' : 'SELL';

      const session = new SignalSession({
        module: 'solana_whale',
        payload: {
          sig,
          wallet,
          dex,
          token,
          mint,
          solAmount: solAmt,
          side,
          kind: 'SWAP',
          solIn,
          solOut,
        },
      });

      const pct = this.history?.magnitudePercentile?.(solAmt);
      const magnitude =
        pct != null
          ? pct
          : magnitudeFromSol(solAmt, this.config.helius.whaleSol, this.config.helius.megaSol);
      const recent = this.history?.recentSimilarCount?.('solana_whale', 15 * 60_000) || 0;
      const novelty = Math.max(0, 1 - recent / 25);

      session.markScored({
        confidence: 0.97,
        magnitude,
        novelty,
        observedAt: session.observed_at,
      });

      this.history?.upsertSession?.(session);
      if (!session.score.publishPaid) return;

      const inserted = this.history?.insertSolanaEvent?.({
        ts: session.observed_at,
        sig,
        wallet,
        kind: 'SWAP',
        solAmount: solAmt,
        token,
        mint,
        dex,
        side,
        sessionId: session.id,
      });
      if (inserted === false) return;

      this.history?.bumpWallet?.(wallet, session.observed_at, solAmt);
      this.alerts += 1;

      const formatted = this.format(session);
      if (this.dispatch) {
        await this.dispatch.publish(session, formatted);
      } else {
        await this.emit({ ...formatted.paid, coalesceMs: 0 });
        if (formatted.x) await this.emit({ ...formatted.x, coalesceMs: 0 });
        session.markPublished();
        this.history?.upsertSession?.(session);
      }
      this.history?.markSolanaPosted?.(sig, 'paid');
      this.settler?.schedule?.(session);

      this.log.info('ALERT solana_whale', {
        sol: Number(solAmt.toFixed(2)),
        side,
        dex,
        wallet: short(wallet),
        score: session.score.total,
        magnitude: Number(magnitude.toFixed(3)),
        session: session.id,
      });
    } finally {
      this.inspecting -= 1;
      if (this.queue.length) setImmediate(() => this.pump());
    }
  }

  async fetchParsedTx(sig) {
    const key = this.config.helius.apiKey;
    const urls = [
      `https://api.helius.xyz/v0/transactions/?api-key=${key}`,
      `https://api.helius.xyz/v0/transactions?api-key=${key}`,
    ];
    for (const url of urls) {
      try {
        const { data } = await axios.post(url, { transactions: [sig] }, { timeout: 12_000 });
        const tx = Array.isArray(data) ? data[0] : data;
        if (tx) return tx;
      } catch (err) {
        this.log.debug('helius parse miss', { sig: short(sig), error: err.message });
      }
    }
    return null;
  }

  format(session) {
    const p = session.payload;
    const mega = p.solAmount >= this.config.helius.megaSol;
    const title = mega
      ? `MEGA WHALE · ${fmt(p.solAmount)} SOL ${p.side}`
      : `WHALE · ${fmt(p.solAmount)} SOL ${p.side}`;
    const body = `${fmt(p.solAmount)} SOL ${p.side} on ${p.dex}. Wallet ${short(p.wallet)}.`;
    const fields = [
      { label: 'DEX', value: p.dex },
      { label: 'Side', value: p.side },
      { label: 'Wallet', value: p.wallet },
      { label: 'Mint', value: p.mint || 'n/a' },
      { label: 'SOL', value: fmt(p.solAmount) },
      { label: 'Score', value: String(session.score?.total ?? '') },
    ];
    const url = `https://solscan.io/tx/${p.sig}`;
    const base = {
      type: 'solana_whale',
      signal_type: 'solana_whale.swap',
      symbol: 'SOL',
      title,
      body,
      fields,
      url,
      sig: p.sig,
      wallet: p.wallet,
      dex: p.dex,
      token: p.token,
      mint: p.mint,
      solAmount: p.solAmount,
      features: {
        x1: session.score?.magnitude || 0,
        x2: session.score?.novelty || 0,
        x3: session.score?.total || 0,
      },
    };
    return {
      paid: {
        ...base,
        tier: 'premium-only',
        channels: ['telegram'],
        key: `sol:paid:${p.sig}`,
        coalesceKey: `sol:paid:${p.sig}`,
      },
      free: session.score?.publishFree
        ? {
            ...base,
            tier: 'public',
            channels: ['telegram'],
            key: `sol:free:${p.sig}`,
            coalesceKey: `sol:free:${p.sig}`,
            title: `${title} (delayed)`,
            body: `${body} Free tier delayed — Premium is live.`,
          }
        : null,
      x: {
        ...base,
        tier: 'public',
        channels: ['twitter'],
        key: `sol:x:${p.sig}`,
        coalesceKey: `sol:x:${p.sig}`,
        title: title.slice(0, 80),
        body: `${fmt(p.solAmount)} SOL ${p.side} on ${p.dex}. ${url}`,
      },
    };
  }

  async postDigest() {
    if (!this.history?.topWallets24h) return;
    const top = this.history.topWallets24h(5);
    if (!top.length) return;
    const lines = top.map((r, i) => {
      const wr =
        r.wins + r.losses > 0
          ? ` · WR ${Math.round((r.wins / (r.wins + r.losses)) * 100)}%`
          : '';
      return `${i + 1}. ${short(r.wallet)} — ${r.hits} hits${wr}`;
    });
    await this.emit({
      type: 'digest',
      signal_type: 'solana_whale.digest',
      tier: 'public',
      key: `digest:${new Date().toISOString().slice(0, 10)}`,
      coalesceKey: `digest:${Date.now()}`,
      coalesceMs: 0,
      title: '24H SMART MONEY LEADERBOARD',
      body: lines.join('\n'),
      fields: top.map((r, i) => ({
        label: `#${i + 1}`,
        value: `${short(r.wallet)} (${r.hits})`,
      })),
    });
  }
}

function classifyDex(tx) {
  const src = String(tx.source || '').toUpperCase();
  if (src.includes('RAYDIUM')) return 'RAYDIUM';
  if (src.includes('ORCA')) return 'ORCA';
  const keys = (tx.accountData || []).map((a) => a.account).join(' ');
  if (keys.includes(RAYDIUM_AMM)) return 'RAYDIUM';
  if (keys.includes(ORCA_WHIRL)) return 'ORCA';
  return src || 'UNKNOWN';
}

function short(w) {
  return w ? `${String(w).slice(0, 4)}..${String(w).slice(-4)}` : '?';
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

module.exports = { SolanaWhaleSignal };
