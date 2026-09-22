/** Fixed-window rate limiting (per key, per minute). In-memory by design. */
export class RateLimit {
  private hits = new Map<string, { windowStart: number; count: number }>();
  private now: () => number;
  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  /**
   * Returns true when allowed. limit <= 0 means unlimited.
   * Window state is pruned opportunistically to bound memory.
   */
  allow(id: string, limit: number, windowMs = 60_000): boolean {
    if (!limit || limit <= 0) return true;
    const now = this.now();
    const row = this.hits.get(id);
    if (!row || now - row.windowStart >= windowMs) {
      this.hits.set(id, { windowStart: now, count: 1 });
      if (this.hits.size > 5000) this.prune(now, windowMs);
      return true;
    }
    row.count += 1;
    return row.count <= limit;
  }

  private prune(now: number, windowMs: number): void {
    for (const [k, v] of this.hits) {
      if (now - v.windowStart >= windowMs) this.hits.delete(k);
    }
  }
}
