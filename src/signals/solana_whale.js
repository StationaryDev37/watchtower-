/**
 * solana_whale — Helius Raydium/Orca whale swaps.
 * Lifecycle: OBSERVED → SCORED → PUBLISHED (paid+X now, free after PAID_LAG_MS) → SETTLED.
 */
'use strict';

const axios = require('axios');
const { SignalPlugin } = require('./base');
const { ResilientWs } = require('../sources/ResilientWs');
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
    this.degraded = false;
    this.seen = 0;
    this.alerts = 0;
    this.inspecting = 0;
  }

  async start() {
    if (!this.config.helius?.apiKey) {
      this.log.info('solana_whale idle — set HELIUS_KEY to enable');
      return;
    }
    if (!this.history) {
      this.log.warn('solana_whale: history not injected — sessions will not persist');
    }

    this.connect();

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
    if (this.ws) this.ws.stop();
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

  connect() {
    const key = this.config.helius.apiKey;
    this.ws = new ResilientWs({
      name: 'helius-solana',
      url: `wss://mainnet.helius-rpc.com/?api-key=${key}`,
      log: this.log,
      onOpen: (ws) => {
        this.degraded = false;
        this.log.info('helius ws open');
        for (const pid of [RAYDIUM_AMM, ORCA_WHIRL]) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: pid,
              method: 'logsSubscribe',
              params: [{ mentions: [pid] }, { commitment: 'confirmed' }],
            })
          );
        }
      },
      onMessage: (msg) => {
        const val = msg?.params?.result?.value;
        if (!val?.signature || val.err) return;
        this.seen += 1;
        this.inspect(val.signature).catch((err) =>
          this.log.debug('inspect failed', { error: err.message })
        );
      },
    });
    const origSchedule = this.ws.scheduleReconnect.bind(this.ws);
    this.ws.scheduleReconnect = (...args) => {
      this.degraded = true;
      return origSchedule(...args);
    };
    this.ws.start();
  }

  async inspect(sig) {
    if (this.inspecting >= this.config.helius.maxInflight) return;
    this.inspecting += 1;
    try {
      const { data } = await axios.post(
        `https://api.helius.xyz/v0/transactions/?api-key=${this.config.helius.apiKey}`,
        { transactions: [sig] },
        { timeout: 15_000 }
      );
      const tx = Array.isArray(data) ? data[0] : null;
      if (!tx) return;

      const swap = tx.events?.swap;
      if (!swap) return;

      const solIn = (swap.nativeInput?.amount || 0) / 1e9;
      const solOut = (swap.nativeOutput?.amount || 0) / 1e9;
      const solAmt = Math.max(solIn, solOut);
      if (solAmt < this.config.helius.whaleSol) return;

      const wallet = tx.feePayer;
      const dex = tx.source || detectDex(tx) || 'UNKNOWN';
      const mint =
        swap.tokenOutputs?.[0]?.mint ||
        swap.tokenInputs?.[0]?.mint ||
        '';
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
        },
      });

      const recent = this.history?.recentSimilarCount?.('solana_whale', 15 * 60_000) || 0;
      const novelty = Math.max(0, 1 - recent / 20);
      session.markScored({
        confidence: 0.95,
        magnitude: magnitudeFromSol(
          solAmt,
          this.config.helius.whaleSol,
          this.config.helius.megaSol
        ),
        novelty,
        observedAt: session.observed_at,
      });

      if (!session.score.publishPaid) {
        this.history?.upsertSession?.(session);
        return;
      }

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
      this.history?.upsertSession?.(session);
      this.alerts += 1;

      const formatted = this.format(session);
      if (this.dispatch) {
        await this.dispatch.publish(session, formatted);
        this.history?.markSolanaPosted?.(sig, 'paid');
      } else {
        // Fallback without Dispatch: emit paid + X directly
        await this.emit({ ...formatted.paid, coalesceMs: 0 });
        await this.emit({ ...formatted.x, coalesceMs: 0 });
        session.markPublished();
        this.history?.upsertSession?.(session);
        this.history?.markSolanaPosted?.(sig, 'paid');
      }

      this.log.info('ALERT solana_whale', {
        sol: solAmt,
        dex,
        wallet: short(wallet),
        score: session.score.total,
        session: session.id,
      });
    } finally {
      this.inspecting -= 1;
    }
  }

  format(session) {
    const p = session.payload;
    const mega = p.solAmount >= this.config.helius.megaSol;
    const title = mega
      ? `MEGA WHALE · ${fmt(p.solAmount)} SOL`
      : `WHALE · ${fmt(p.solAmount)} SOL`;
    const body = `${fmt(p.solAmount)} SOL ${p.side} on ${p.dex}. Wallet ${short(p.wallet)}.`;
    const fields = [
      { label: 'DEX', value: p.dex },
      { label: 'Side', value: p.side },
      { label: 'Wallet', value: p.wallet },
      { label: 'Token', value: p.token },
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
            body: `${body} Free tier is delayed — Premium is live.`,
          }
        : null,
      x: {
        ...base,
        tier: 'public',
        channels: ['twitter'],
        key: `sol:x:${p.sig}`,
        coalesceKey: `sol:x:${p.sig}`,
        title: title.slice(0, 80),
        body: `${fmt(p.solAmount)} SOL on ${p.dex}. ${url}`,
      },
    };
  }

  async postDigest() {
    if (!this.history?.topWallets24h) return;
    const top = this.history.topWallets24h(5);
    if (!top.length) return;
    const lines = top.map(
      (r, i) => `${i + 1}. ${short(r.wallet)} — ${r.hits} whale swaps`
    );
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

function detectDex(tx) {
  const src = String(tx.source || '').toUpperCase();
  if (src.includes('RAYDIUM')) return 'RAYDIUM';
  if (src.includes('ORCA')) return 'ORCA';
  return null;
}

function short(w) {
  return w ? `${w.slice(0, 4)}..${w.slice(-4)}` : '?';
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

module.exports = { SolanaWhaleSignal };
