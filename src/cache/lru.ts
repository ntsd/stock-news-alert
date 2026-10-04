interface CacheEntry {
  addedAt: number;
}

export class BoundedTtlLruCache {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly cache: Map<number, CacheEntry>;

  /**
   * @param maxSize Maximum number of article IDs to store before evicting oldest (default 10,000)
   * @param ttlMs Time-to-live in milliseconds (default 48 hours = 172,800,000 ms)
   */
  constructor(maxSize = 10000, ttlMs = 48 * 60 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  /**
   * Check if article ID has been seen and is not expired.
   */
  public has(id: number): boolean {
    const entry = this.cache.get(id);
    if (!entry) {
      return false;
    }

    // Check if expired
    if (Date.now() - entry.addedAt > this.ttlMs) {
      this.cache.delete(id);
      return false;
    }

    return true;
  }

  /**
   * Add article ID to cache. Evicts oldest if size exceeds maxSize.
   */
  public add(id: number): void {
    if (this.cache.has(id)) {
      this.cache.delete(id);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (first item in Map iterator)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(id, { addedAt: Date.now() });
  }

  /**
   * Return active cache size.
   */
  public get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries.
   */
  public clear(): void {
    this.cache.clear();
  }
}
