const { ethers } = require('ethers');
const { SignalPlugin } = require('./base');

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

/**
 * WhaleSignal — watched-address ERC-20 transfers only.
 * Refuses unfiltered Transfer subscriptions (will OOM a 1 GB Oracle box).
 * This is commodity plumbing; replace/extend with edge plugins for paid retention.
 */
class WhaleSignal extends SignalPlugin {
  constructor(config, log, bus) {
    super(config, log, bus);
    this.name = 'whale';
    this.provider = null;
    this.running = false;
    this.seen = 0;
  }

  async start() {
    if (!this.config.eth.rpcUrl) {
      this.log.info('Whale signal idle — set ETH_RPC_URL + WATCH_ADDRESSES');
      return;
    }
    if (!this.config.eth.watchAddresses.length) {
      this.log.error('Whale signal refused: empty WATCH_ADDRESSES (memory safety)');
      return;
    }

    this.provider = new ethers.JsonRpcProvider(this.config.eth.rpcUrl);
    this.running = true;

    // Filter per watched address (from OR to) — never subscribe to all Transfers
    for (const addr of this.config.eth.watchAddresses) {
      const padded = ethers.zeroPadValue(ethers.getAddress(addr), 32);
      this.provider.on({ topics: [ERC20_TRANSFER_TOPIC, padded] }, (log) => {
        this.handleLog(log).catch((err) =>
          this.log.error('Whale handler failed', { error: err.message })
        );
      });
      this.provider.on({ topics: [ERC20_TRANSFER_TOPIC, null, padded] }, (log) => {
        this.handleLog(log).catch((err) =>
          this.log.error('Whale handler failed', { error: err.message })
        );
      });
    }

    this.log.info('Whale signal subscribed (filtered)', {
      watches: this.config.eth.watchAddresses.length,
    });
  }

  async stop() {
    if (this.provider) this.provider.removeAllListeners();
    this.running = false;
  }

  status() {
    return {
      running: this.running,
      seen: this.seen,
      rpcConfigured: Boolean(this.config.eth.rpcUrl),
      watches: this.config.eth.watchAddresses.length,
    };
  }

  async handleLog(raw) {
    this.seen += 1;
    if (!raw?.topics || raw.topics.length < 3) return;

    const from = topicToAddress(raw.topics[1]);
    const to = topicToAddress(raw.topics[2]);
    const value = BigInt(raw.data || '0x0');
    const amountApprox = Number(value) / 1e18;
    if (!Number.isFinite(amountApprox) || amountApprox < this.config.thresholds.whaleMinAmount) {
      return;
    }

    await this.emit({
      type: 'whale',
      tier: 'premium',
      key: `whale:${raw.transactionHash}:${raw.index}`,
      title: 'Whale transfer detected',
      body: `${fmtNum(amountApprox)} tokens moved ${shorten(from)} → ${shorten(to)}`,
      url: `https://etherscan.io/tx/${raw.transactionHash}`,
      fields: [
        { label: 'From', value: from },
        { label: 'To', value: to },
        { label: 'Token', value: raw.address },
        { label: 'Tx', value: raw.transactionHash },
      ],
      teaser: true,
    });
  }
}

function topicToAddress(topic) {
  return ethers.getAddress(`0x${topic.slice(26)}`);
}

function shorten(addr) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtNum(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

module.exports = { WhaleSignal };
