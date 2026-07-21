const axios = require('axios');
const { SignalPlugin } = require('./base');
const { ResilientWs } = require('../feeds/resilientWs');

const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const ORCA_WHIRL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

/**
 * Solana DEX whale swaps via Helius (Raydium + Orca).
 * Product model from unchained-watchtower:
 *   paid Telegram + X  → immediate
 *   free Telegram      → delayed (default 5 min)
 *   daily smart-money leaderboard digest
 */
class SolanaWhaleSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'solana_whale';
    this.ws = null;
    this.freeTimer = null;
    this.digestTimer = null;
    this.degraded = false;
    this.seen = 0;
    this.alerts = 0;
    this.inspecting = 0;
  }

  async start() {
    if (!this.config.helius.apiKey) {
      this.log.info('solana_whale idle — set HELIUS_KEY to enable');
      return;
    }
    if (!this.store) {
      this.log.warn('solana_whale: store not injected — events will not persist');
    } else {
      this.store.ensureSolanaTables();
    }

    this.connect();

    this.freeTimer = setInterval(() => {
      this.flushFreeTier().catch((err) =>
        this.log.error('free-tier flush failed', { error: err.message })
      );
    }, this.config.helius.freeFlushSec * 1000);
    if (this.freeTimer.unref) this.freeTimer.unref();

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
    if (this.freeTimer) clearInterval(this.freeTimer);
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
    // Mark degraded when socket reports it
    const origSchedule = this.ws.scheduleReconnect.bind(this.ws);
    this.ws.scheduleReconnect = (...args) => {
      this.degraded = true;
      return origSchedule(...args);
    };
    this.ws.start();
  }

  async inspect(sig) {
    // Bound concurrent Helius enhanced-tx fetches on 1 GB box
    if (this.inspecting >= this.config.helius.maxInflight) return;
    this.inspecting += 1;
    try {
      const { data } = await axios.post(
        `https://api.helius.xyz/v0/transactions/?api-key=${this.config.helius.apiKey}`,
        { transactions: [sig] },
        { timeout: 15000 }
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
        swap.tokenInputs?.[0]?.mint || swap.tokenOutputs?.[0]?.mint || '';
      const token = mint ? mint.slice(0, 8) : 'SOL pair';

      const inserted = this.store?.insertSolanaEvent?.({
        ts: Date.now(),
        sig,
        wallet,
        kind: 'SWAP',
        solAmount: solAmt,
        token,
        dex,
      });
      if (inserted === false) return; // duplicate

      this.store?.bumpWallet?.(wallet, Date.now());
      this.alerts += 1;

      const mega = solAmt >= this.config.helius.megaSol;
      const title = mega
        ? `MEGA WHALE · ${fmt(solAmt)} SOL`
        : `WHALE · ${fmt(solAmt)} SOL`;
      const body = `${fmt(solAmt)} SOL swap on ${dex}. Wallet ${short(wallet)}.`;
      const fields = [
        { label: 'DEX', value: dex },
        { label: 'Wallet', value: wallet },
        { label: 'Token', value: token },
        { label: 'SOL', value: fmt(solAmt) },
      ];
      const url = `https://solscan.io/tx/${sig}`;
      const base = {
        type: 'solana_whale',
        symbol: 'SOL',
        title,
        body,
        fields,
        url,
        solAmount: solAmt,
        wallet,
        dex,
        token,
        sig,
      };

      // Paid Telegram immediately (no free teaser)
      await this.emit({
        ...base,
        tier: 'premium-only',
        key: `sol:paid:${sig}`,
        channels: ['telegram'],
        coalesceKey: `sol:paid:${sig}`,
        coalesceMs: 0,
      });

      // X immediately (acquisition)
      await this.emit({
        ...base,
        tier: 'public',
        key: `sol:x:${sig}`,
        channels: ['twitter'],
        coalesceKey: `sol:x:${sig}`,
        coalesceMs: 0,
      });

      this.store?.markSolanaPosted?.(sig, 'paid');
      this.log.info('solana whale alert', { sol: solAmt, dex, wallet: short(wallet) });
    } finally {
      this.inspecting -= 1;
    }
  }

  async flushFreeTier() {
    if (!this.store?.dueSolanaFree) return;
    const cutoff = Date.now() - this.config.helius.freeLagMs;
    const rows = this.store.dueSolanaFree(cutoff, 5);
    for (const ev of rows) {
      const mega = ev.sol_amount >= this.config.helius.megaSol;
      await this.emit({
        type: 'solana_whale',
        tier: 'public',
        channels: ['telegram'],
        key: `sol:free:${ev.sig}`,
        coalesceKey: `sol:free:${ev.sig}`,
        coalesceMs: 0,
        symbol: 'SOL',
        title: `${mega ? 'MEGA WHALE' : 'WHALE'} · ${fmt(ev.sol_amount)} SOL (5m delayed)`,
        body: `${fmt(ev.sol_amount)} SOL swap on ${ev.dex}. Wallet ${short(ev.wallet)}. Free tier is delayed — Premium is live.`,
        fields: [
          { label: 'DEX', value: ev.dex },
          { label: 'Wallet', value: ev.wallet },
          { label: 'Token', value: ev.token || 'SOL pair' },
        ],
        url: `https://solscan.io/tx/${ev.sig}`,
        delayed: true,
      });
      this.store.markSolanaPosted(ev.sig, 'free');
    }
  }

  async postDigest() {
    if (!this.store?.topWallets24h) return;
    const top = this.store.topWallets24h(5);
    if (!top.length) return;
    const lines = top.map(
      (r, i) => `${i + 1}. ${short(r.wallet)} — ${r.hits} whale swaps`
    );
    const title = '24H SMART MONEY LEADERBOARD';
    const body = lines.join('\n');
    await this.emit({
      type: 'digest',
      tier: 'public',
      key: `digest:${new Date().toISOString().slice(0, 10)}`,
      coalesceKey: `digest:${Date.now()}`,
      title,
      body,
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
