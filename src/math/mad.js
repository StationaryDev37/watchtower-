/**
 * Robust statistics — MAD / median used throughout spike & funding math.
 * z = 0.6745 * (x - med) / mad   (consistency with normal σ)
 * robustσ = 1.4826 * MAD
 */

function median(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function mad(arr, med = median(arr)) {
  if (!arr.length) return 0;
  return median(arr.map((x) => Math.abs(x - med)));
}

function madZ(x, window) {
  const med = median(window);
  const m = mad(window, med);
  if (m <= 0) return { z: 0, med, mad: 0 };
  return { z: (0.6745 * (x - med)) / m, med, mad: m };
}

function robustSigma(arr) {
  return 1.4826 * mad(arr);
}

module.exports = { median, mad, madZ, robustSigma };
