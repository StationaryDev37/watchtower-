const fs = require('fs');
const path = require('path');

/**
 * ConvictionScorer — logistic over 7 features → stars 1..5.
 * Cold start: priors in data/conviction.json.
 * Nightly IRLS retrain when n_outcomes ≥ minOutcomes.
 *
 * p = σ(β0 + Σ βi xi)
 * conviction = 1 + floor(p * 5) clipped [1,5]
 */
class ConvictionScorer {
  constructor(config, log, { history } = {}) {
    this.config = config;
    this.log = log;
    this.history = history || null;
    this.model = null;
    this.trainTimer = null;
  }

  start() {
    this.model = this.load();
    this.scheduleTrain();
    this.log.info('ConvictionScorer ready', {
      version: this.model.version,
      n_train: this.model.n_train,
    });
  }

  stop() {
    if (this.trainTimer) clearTimeout(this.trainTimer);
  }

  load() {
    const p = this.config.conviction.path;
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      this.log.warn('conviction load failed', { error: err.message });
    }
    return defaultPriors();
  }

  save(model) {
    const p = this.config.conviction.path;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(model, null, 2));
    fs.renameSync(tmp, p);
    this.model = model;
  }

  features(alert) {
    const f = alert.features || {};
    const hour = new Date(alert.ts || Date.now()).getUTCHours();
    let session = 'asia';
    if (hour >= 7 && hour < 12) session = 'eu-am';
    else if (hour >= 12 && hour < 17) session = 'us-am';
    else if (hour >= 17 && hour < 22) session = 'us-pm';

    return {
      x1: Number(f.z || 0),
      x2: Number(f.zVol || 0),
      x3: Number(f.funding_dev || 0),
      x4: Number(f.liq_asym || 0),
      x5: session,
      x6: Number(f.symbol_beta || 1),
      x7: alert.coalesced || f.coalesced ? 1 : 0,
    };
  }

  score(alert) {
    if (!this.config.conviction.enabled || !this.model) return null;
    const x = this.features(alert);
    const m = this.model;
    let z =
      m.β0 +
      m.β1 * x.x1 +
      m.β2 * x.x2 +
      m.β3 * x.x3 +
      m.β4 * x.x4 +
      (m.x5?.[x.x5] || 0) +
      m.β6 * x.x6 +
      m.β7 * x.x7;
    const p = 1 / (1 + Math.exp(-z));
    const conviction = Math.max(1, Math.min(5, 1 + Math.floor(p * 5)));
    return {
      conviction,
      p,
      meta: {
        version: m.version,
        n_train: m.n_train,
        stars: '★'.repeat(conviction) + '☆'.repeat(5 - conviction),
      },
    };
  }

  scheduleTrain() {
    // Simple daily 02:00 UTC check every hour
    const tick = async () => {
      const now = new Date();
      if (now.getUTCHours() === 2 && now.getUTCMinutes() < 10) {
        try {
          await this.train();
        } catch (err) {
          this.log.warn('conviction train failed', { error: err.message });
        }
      }
      this.trainTimer = setTimeout(tick, 60 * 60 * 1000);
      if (this.trainTimer.unref) this.trainTimer.unref();
    };
    this.trainTimer = setTimeout(tick, 60 * 1000);
    if (this.trainTimer.unref) this.trainTimer.unref();
  }

  /**
   * IRLS logistic regression on 7 features (pure JS).
   * Returns null if insufficient outcomes.
   */
  async train() {
    if (!this.history) return null;
    const rows = this.history.outcomesForTraining(100000);
    if (rows.length < this.config.conviction.minOutcomes) {
      this.log.info('conviction train skipped — insufficient outcomes', {
        n: rows.length,
        need: this.config.conviction.minOutcomes,
      });
      return null;
    }

    const X = [];
    const y = [];
    for (const row of rows) {
      let alert;
      try {
        alert = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      const f = this.features(alert);
      X.push([
        1,
        f.x1,
        f.x2,
        f.x3,
        f.x4,
        sessionCode(f.x5),
        f.x6,
        f.x7,
      ]);
      y.push(row.hit_positive ? 1 : 0);
    }
    if (X.length < this.config.conviction.minOutcomes) return null;

    const beta = irls(X, y, 12);
    const model = {
      β0: beta[0],
      β1: beta[1],
      β2: beta[2],
      β3: beta[3],
      β4: beta[4],
      x5: {
        asia: beta[5] * sessionCode('asia'),
        'eu-am': beta[5] * sessionCode('eu-am'),
        'us-am': beta[5] * sessionCode('us-am'),
        'us-pm': beta[5] * sessionCode('us-pm'),
      },
      β6: beta[6],
      β7: beta[7],
      version: `trained-n=${X.length}`,
      n_train: X.length,
      trained_at: new Date().toISOString(),
    };
    this.save(model);
    this.log.info('ConvictionScorer trained', { n: X.length, version: model.version });
    return model;
  }
}

function defaultPriors() {
  return {
    β0: -1.2,
    β1: 0.42,
    β2: 0.35,
    β3: 0.28,
    β4: 0.22,
    x5: { asia: -0.05, 'eu-am': 0.0, 'us-am': 0.08, 'us-pm': -0.03 },
    β6: 0.1,
    β7: 0.45,
    version: 'prior-v1',
    n_train: 0,
  };
}

function sessionCode(s) {
  return { asia: 0, 'eu-am': 1, 'us-am': 2, 'us-pm': 3 }[s] || 0;
}

/** Iteratively reweighted least squares for logistic regression */
function irls(X, y, iters = 12) {
  const n = X.length;
  const p = X[0].length;
  let beta = new Array(p).fill(0);
  for (let it = 0; it < iters; it++) {
    const W = [];
    const z = [];
    for (let i = 0; i < n; i++) {
      const eta = dot(X[i], beta);
      const mu = 1 / (1 + Math.exp(-clamp(eta, -20, 20)));
      const w = Math.max(mu * (1 - mu), 1e-6);
      W.push(w);
      z.push(eta + (y[i] - mu) / w);
    }
    beta = solveWLS(X, W, z);
  }
  return beta;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Solve (Xᵀ W X) β = Xᵀ W z via Gaussian elimination */
function solveWLS(X, W, z) {
  const n = X.length;
  const p = X[0].length;
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      b[j] += X[i][j] * W[i] * z[i];
      for (let k = 0; k < p; k++) {
        A[j][k] += X[i][j] * W[i] * X[i][k];
      }
    }
  }
  // ridge for stability
  for (let j = 0; j < p; j++) A[j][j] += 1e-4;
  return gauss(A, b);
}

function gauss(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col] || 1e-12;
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

module.exports = { ConvictionScorer, defaultPriors, irls };
