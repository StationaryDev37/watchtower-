const { ethers } = require('ethers');

const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

class WhaleSignal {
  constructor(config, log, bus) {
    this.name = 'whale';
    this.config = config;
    this.log = log;
    this.bus = bus;
    this.provider = null;
    this.running = false;
    this.seen = 0;
  }

  async start() {
    if (!this.config.eth.rpcUrl) {
      this.log.info('Whale signal idle — set ETH_RPC_URL to enable (premium differentiator)');
      return;
    }

    this.provider = new ethers.JsonRpcProvider(this.config.eth.rpcUrl);
    this.running = true;
    this.provider.on({ topics: [ERC20_TRANSFER_TOPIC] }, (log) => {
      this.handleLog(log).catch((err) =>
        this.log.error('Whale handler failed', { error: err.message })
      );
    });

    this.log.info('Whale signal subscribed', {
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
    };
  }

  async handleLog(raw) {
    this.seen += 1;
    if (!raw?.topics || raw.topics.length < 3) return;

    const from = topicToAddress(raw.topics[1]);
    const to = topicToAddress(raw.topics[2]);
    const watches = this.config.eth.watchAddresses.map((a) => a.toLowerCase());
    if (watches.length && !watches.includes(from) && !watches.includes(to)) return;

    const value = BigInt(raw.data || '0x0');
    const amountApprox = Number(value) / 1e18;
    if (!Number.isFinite(amountApprox) || amountApprox < this.config.thresholds.whaleMinAmount) {
      return;
    }

    // Whale alerts are the paid wedge — free channel gets teaser only
    await this.bus.publish({
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
      // Free channel still gets a redacted teaser via tier=premium (not premium-only)
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
