/**
 * Health semantics:
 *   healthy   200 — critical deps OK
 *   degraded  200 — non-critical open / feed soft-down
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
    const enabled = new Set(this.config.signalsEnabled || []);

    for (const [name, br] of Object.entries(breakers)) {
      deps[name] = br.status();
    }
    deps.priceRouter = this.deps.priceRouter?.status?.() || { live: false };
    deps.telegram = {
      enabled: Boolean(
        this.config.telegram.botToken &&
          (this.config.telegram.freeChatId || this.config.telegram.premiumChatId)
      ),
    };
    deps.stripe = {
      enabled: Boolean(this.config.stripe.secretKey || this.config.cryptoRail?.apiKey),
    };

    const signalStatus = this.deps.signals?.()?.status?.() || {};
    deps.solana_whale = signalStatus.solana_whale || null;
    deps.new_pool_watch = signalStatus.new_pool_watch || null;
    deps.helius = {
      apiKey: Boolean(this.config.helius?.apiKey),
      whaleRunning: Boolean(signalStatus.solana_whale?.running),
      whaleDegraded: Boolean(signalStatus.solana_whale?.degraded),
      poolsRunning: Boolean(signalStatus.new_pool_watch?.running),
    };

    const criticalDown = [];
    if (criticalNames.has('priceRouter') && enabled.has('market')) {
      const live =
        deps.priceRouter.live ||
        deps.priceRouter.symbols > 0 ||
        this.config.dryRun;
      if (!live) criticalDown.push('priceRouter');
    }
    if (criticalNames.has('telegram')) {
      if (!deps.telegram.enabled && !this.config.dryRun) criticalDown.push('telegram');
    }
    if (criticalNames.has('helius')) {
      const need =
        enabled.has('solana_whale') || enabled.has('new_pool_watch');
      if (need && !this.config.dryRun) {
        if (!deps.helius.apiKey) criticalDown.push('helius');
        else if (
          enabled.has('solana_whale') &&
          !deps.helius.whaleRunning &&
          !deps.solana_whale?.socket?.connected
        ) {
          // allow brief startup — only mark down if degraded after start attempt
          if (deps.helius.whaleDegraded) criticalDown.push('helius');
        }
      }
    }

    for (const [name, st] of Object.entries(breakers)) {
      if (criticalNames.has(name) && st.state === 'open') criticalDown.push(name);
    }

    const anyNonCriticalOpen = Object.entries(breakers).some(
      ([name, st]) => !criticalNames.has(name) && st.state === 'open'
    );
    const priceDegraded = Boolean(deps.priceRouter.degraded);
    const heliusDegraded =
      deps.helius.whaleDegraded || Boolean(signalStatus.new_pool_watch?.degraded);

    let status = 'healthy';
    let httpStatus = 200;
    if (criticalDown.length) {
      status = 'unhealthy';
      httpStatus = 503;
    } else if (anyNonCriticalOpen || priceDegraded || heliusDegraded) {
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
