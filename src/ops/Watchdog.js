/**
 * RSS watchdog for Oracle Always Free (1 GB).
 * SOFT → GC hint; HARD → shed noisiest plugin; FATAL → graceful reload.
 */
class Watchdog {
  constructor(config, log, { signals, bus, opsAlert, onFatal }) {
    this.config = config;
    this.log = log;
    this.signals = signals;
    this.bus = bus;
    this.opsAlert = opsAlert;
    this.onFatal = onFatal;
    this.timer = null;
    this.dropped = [];
    this.lastRssMb = 0;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.config.watchdog.intervalSec * 1000);
    if (this.timer.unref) this.timer.unref();
    this.log.info('Watchdog armed', {
      soft: this.config.watchdog.softMb,
      hard: this.config.watchdog.hardMb,
      fatal: this.config.watchdog.fatalMb,
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    this.lastRssMb = rssMb;
    const { softMb, hardMb, fatalMb } = this.config.watchdog;

    if (rssMb >= fatalMb) {
      this.log.error('RSS FATAL — requesting graceful reload', { rssMb });
      await this.opsAlert?.(`Watchtower FATAL RSS ${rssMb}MB ≥ ${fatalMb}MB — reloading`);
      this.onFatal?.();
      return;
    }

    if (rssMb >= hardMb) {
      const victim = this.pickNoisiest();
      if (victim) {
        victim.pause();
        this.dropped.push({ name: victim.name, at: new Date().toISOString(), rssMb });
        this.log.warn('RSS HARD — shed plugin', { name: victim.name, rssMb });
        await this.opsAlert?.(
          `Watchtower shed "${victim.name}" — RSS ${rssMb}MB ≥ ${hardMb}MB`
        );
      }
      return;
    }

    if (rssMb >= softMb) {
      this.log.warn('RSS SOFT', { rssMb });
      if (global.gc) {
        try {
          global.gc();
        } catch {
          /* ignore */
        }
      }
    }
  }

  pickNoisiest() {
    const rates = this.bus?.ingressPerMin?.() || {};
    const candidates = this.signals.signals.filter((s) => !s.paused && s.name !== 'market');
    candidates.sort((a, b) => (rates[b.name] || 0) - (rates[a.name] || 0));
    return candidates[0] || this.signals.signals.find((s) => !s.paused && s.name !== 'market');
  }

  status() {
    return {
      rssMb: this.lastRssMb || Math.round(process.memoryUsage().rss / 1024 / 1024),
      softMb: this.config.watchdog.softMb,
      hardMb: this.config.watchdog.hardMb,
      fatalMb: this.config.watchdog.fatalMb,
      dropped: this.dropped,
    };
  }
}

module.exports = { Watchdog };
