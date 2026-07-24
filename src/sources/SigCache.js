/**
 * Bounded LRU set for signature / id dedup. O(1) insert+has, fixed RAM.
 */
'use strict';

class SigCache {
  constructor(max = 5000) {
    this.max = Math.max(1, Number(max) || 5000);
    this.map = new Map(); // key -> ts
  }

  has(key) {
    return this.map.has(key);
  }

  add(key, ts = Date.now()) {
    if (this.map.has(key)) {
      this.map.delete(key); // refresh LRU order
    }
    this.map.set(key, ts);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  /** Returns true if newly seen; false if duplicate. */
  check(key, ts = Date.now()) {
    if (this.map.has(key)) return false;
    this.add(key, ts);
    return true;
  }

  size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { SigCache };
