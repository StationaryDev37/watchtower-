/**
 * Signal score vector — confidence / magnitude / novelty / urgency.
 * total = 0.35·c + 0.30·m + 0.20·n + 0.15·u
 */
'use strict';

const W = { confidence: 0.35, magnitude: 0.3, novelty: 0.2, urgency: 0.15 };

const PUBLISH_THRESHOLD_PAID = Number(process.env.PUBLISH_THRESHOLD_PAID ?? 0.55);
const PUBLISH_THRESHOLD_FREE = Number(process.env.PUBLISH_THRESHOLD_FREE ?? 0.65);

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function urgencyFromAge(observedAt, now = Date.now(), tauMs = 60_000) {
  const age = Math.max(0, now - (observedAt || now));
  return clamp01(Math.exp(-age / tauMs));
}

/**
 * @param {object} parts
 * @param {number} parts.confidence  parse/enrich success
 * @param {number} parts.magnitude   size vs rolling percentile (0..1)
 * @param {number} parts.novelty     1 - recentSimilar/window
 * @param {number} [parts.urgency]   freshness; computed from observedAt if omitted
 * @param {number} [parts.observedAt]
 */
function score(parts = {}) {
  const confidence = clamp01(parts.confidence ?? 0);
  const magnitude = clamp01(parts.magnitude ?? 0);
  const novelty = clamp01(parts.novelty ?? 1);
  const urgency =
    parts.urgency != null
      ? clamp01(parts.urgency)
      : urgencyFromAge(parts.observedAt ?? Date.now());
  const total =
    W.confidence * confidence +
    W.magnitude * magnitude +
    W.novelty * novelty +
    W.urgency * urgency;
  return {
    confidence,
    magnitude,
    novelty,
    urgency,
    total: Math.round(total * 1000) / 1000,
    thresholds: {
      paid: PUBLISH_THRESHOLD_PAID,
      free: PUBLISH_THRESHOLD_FREE,
    },
    publishPaid: total >= PUBLISH_THRESHOLD_PAID,
    publishFree: total >= PUBLISH_THRESHOLD_FREE,
  };
}

/** Map SOL size onto [0,1] using WHALE/MEGA anchors. */
function magnitudeFromSol(solAmt, whaleSol = 500, megaSol = 2000) {
  if (!(solAmt > 0)) return 0;
  if (solAmt >= megaSol) return 1;
  if (solAmt <= whaleSol) return clamp01(solAmt / whaleSol) * 0.55;
  return 0.55 + 0.45 * ((solAmt - whaleSol) / Math.max(1, megaSol - whaleSol));
}

module.exports = {
  score,
  magnitudeFromSol,
  urgencyFromAge,
  clamp01,
  PUBLISH_THRESHOLD_PAID,
  PUBLISH_THRESHOLD_FREE,
  WEIGHTS: W,
};
