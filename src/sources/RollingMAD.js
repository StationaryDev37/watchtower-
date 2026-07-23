/**
 * O(log n) rolling median + MAD helpers over a fixed time window.
 * Two-heap median is available; MAD-z currently uses sorted median (W≈300 is <1ms).
 */
'use strict';

class MinHeap {
  constructor() {
    this.a = [];
  }
  size() {
    return this.a.length;
  }
  peek() {
    return this.a[0];
  }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p] <= a[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < n && a[l] < a[m]) m = l;
        if (r < n && a[r] < a[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

class MaxHeap extends MinHeap {
  push(v) {
    super.push(-v);
  }
  pop() {
    return -super.pop();
  }
  peek() {
    return -super.peek();
  }
}

class RollingWindow {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.buf = []; // { ts, v }
  }

  push(ts, v) {
    this.buf.push({ ts, v });
    const cutoff = ts - this.windowMs;
    while (this.buf.length && this.buf[0].ts < cutoff) this.buf.shift();
  }

  values() {
    return this.buf.map((x) => x.v);
  }

  size() {
    return this.buf.length;
  }
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

function madZ(arr, x) {
  if (arr.length < 8) return { z: 0, med: NaN, mad: NaN };
  const med = median(arr);
  const dev = arr.map((v) => Math.abs(v - med));
  const mad = median(dev);
  if (!(mad > 0)) return { z: 0, med, mad };
  const z = (0.6745 * (x - med)) / mad;
  return { z, med, mad };
}

module.exports = { RollingWindow, MinHeap, MaxHeap, median, madZ };
