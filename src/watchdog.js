/**
 * RSS watchdog for Oracle Always Free (1 GB).
 * Cross ceiling → drop noisiest enabled signal plugins, ops-alert, don't crash.
 */
class MemoryWatchdog {
  constructor(config, log, { signals, opsAlert }) {
    this.config = config;
    this.log = log;
    this.signals = signals;
    this.opsAlert = opsAlert;
    this.timer = null;
    this.dropped = [];
    this.lastRssMb = 0;
  }

  start() {
    const every = this.config.watchdog.intervalSec * 1000;
    this.timer = setInterval(() => this.tick(), every);
    if (this.timer.unref) this.timer.unref();
    this.log.info('Memory watchdog armed', {
      ceilingMb: this.config.watchdog.rssCeilingMb,
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    this.lastRssMb = rssMb;
    if (rssMb < this.config.watchdog.rssCeilingMb) return;

    this.log.warn('RSS ceiling breached', { rssMb, ceiling: this.config.watchdog.rssCeilingMb });
    const victim = this.pickNoisiest();
    if (!victim) {
      await this.opsAlert?.(
        `Watchtower RSS ${rssMb}MB over ceiling; no droppable plugins left`
      );
      return;
    }

    try {
      await victim.stop();
      this.signals.signals = this.signals.signals.filter((s) => s !== victim);
      this.dropped.push({ name: victim.name, at: new Date().toISOString(), rssMb });
      this.log.warn('Dropped plugin to reclaim memory', { name: victim.name, rssMb });
      await this.opsAlert?.(
        `Watchtower dropped signal "${victim.name}" — RSS ${rssMb}MB ≥ ${this.config.watchdog.rssCeilingMb}MB ceiling`
      );
    } catch (err) {
      this.log.error('Watchdog drop failed', { error: err.message });
    }
  }

  pickNoisiest() {
    const rank = { market: 1, liquidations: 2, funding: 3, whale: 4, stables: 5, cex_flow: 5 };
    const droppable = this.signals.signals
      .filter((s) => s.name !== 'market') // keep at least one price-derived path if possible
      .sort((a, b) => (rank[b.name] || 0) - (rank[a.name] || 0));
    return droppable[0] || this.signals.signals.find((s) => s.name !== 'market') || null;
  }

  status() {
    return {
      rssMb: this.lastRssMb || Math.round(process.memoryUsage().rss / 1024 / 1024),
      ceilingMb: this.config.watchdog.rssCeilingMb,
      dropped: this.dropped,
    };
  }
}

module.exports = { MemoryWatchdog };
