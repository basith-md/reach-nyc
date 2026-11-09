/** Binary min-heap of (key, value) with typed arrays; lazy deletion is handled by the caller. */
export class Heap {
  keys: Float64Array; vals: Int32Array; size = 0;
  constructor(cap = 1 << 16) { this.keys = new Float64Array(cap); this.vals = new Int32Array(cap); }
  clear() { this.size = 0; }
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const k2 = new Float64Array(this.size * 2); k2.set(this.keys); this.keys = k2;
      const v2 = new Int32Array(this.size * 2); v2.set(this.vals); this.vals = v2;
    }
    let i = this.size++;
    const K = this.keys, V = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= k) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = k; V[i] = v;
  }
  /** Pops the min; returns value, key in this.topKey. */
  topKey = 0;
  pop(): number {
    const K = this.keys, V = this.vals;
    const rv = V[0]; this.topKey = K[0];
    const n = --this.size;
    if (n > 0) {
      const k = K[n], v = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= k) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = k; V[i] = v;
    }
    return rv;
  }
}
