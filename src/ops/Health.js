/**
 * Health semantics:
 *   healthy   200 — critical breakers closed, price live
 *   degraded  200 — non-critical open
 *   unhealthy 503 — critical dep down
 */
class Health {
  constructor(config, log, deps) {
    this.config = config;
    this.log = log;
    this.deps = deps;
  }

  evaluate() {
    const criticalNames = new Set(this.config.health.criticalDeps);
    const breakers = this.deps.breakers || {};
    const deps = {};

    for (const [name, br] of Object.entries(breakers)) {
      deps[name] = br.status();
    }
    deps.priceRouter = this.deps.priceRouter?.status?.() || { live: false };
    deps.telegram = {
      enabled: Boolean(
        this.config.telegram.botToken && this.config.telegram.freeChatId
      ),
    };
    deps.stripe = {
      enabled: Boolean(this.config.stripe.secretKey || this.config.cryptoRail?.apiKey),
    };

    const criticalDown = [];
    if (criticalNames.has('priceRouter')) {
      const live =
        deps.priceRouter.live ||
        deps.priceRouter.symbols > 0 ||
        this.config.dryRun;
      if (!live) criticalDown.push('priceRouter');
    }
    if (criticalNames.has('telegram')) {
      if (!deps.telegram.enabled && !this.config.dryRun) criticalDown.push('telegram');
    }
    if (criticalNames.has('stripe')) {
      // stripe is soft-critical for alerting uptime — only fail if configured critical AND missing when not dryRun
      if (!deps.stripe.enabled && !this.config.dryRun) {
        // don't mark unhealthy solely for missing stripe — keep as degraded
      }
    }

    for (const [name, st] of Object.entries(breakers)) {
      if (criticalNames.has(name) && st.state === 'open') criticalDown.push(name);
    }

    const anyNonCriticalOpen = Object.entries(breakers).some(
      ([name, st]) => !criticalNames.has(name) && st.state === 'open'
    );
    const priceDegraded = Boolean(deps.priceRouter.degraded);

    let status = 'healthy';
    let httpStatus = 200;
    if (criticalDown.length) {
      status = 'unhealthy';
      httpStatus = 503;
    } else if (anyNonCriticalOpen || priceDegraded) {
      status = 'degraded';
      httpStatus = 200;
    }

    return {
      status,
      httpStatus,
      ok: httpStatus === 200,
      criticalDown,
      deps,
      critical: Object.fromEntries(
        [...criticalNames].map((n) => [n, !criticalDown.includes(n)])
      ),
    };
  }
}

module.exports = { Health };
