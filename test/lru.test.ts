import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedTtlLruCache } from '../src/cache/lru.js';

describe('BoundedTtlLruCache', () => {
  it('should store and retrieve article IDs', () => {
    const cache = new BoundedTtlLruCache(10, 10000);
    assert.equal(cache.has(101), false);
    cache.add(101);
    assert.equal(cache.has(101), true);
    assert.equal(cache.size, 1);
  });

  it('should respect maximum capacity and evict oldest entry', () => {
    const cache = new BoundedTtlLruCache(3, 10000);
    cache.add(1);
    cache.add(2);
    cache.add(3);
    assert.equal(cache.size, 3);
    assert.equal(cache.has(1), true);

    // Adding 4th item should evict 1
    cache.add(4);
    assert.equal(cache.size, 3);
    assert.equal(cache.has(1), false);
    assert.equal(cache.has(2), true);
    assert.equal(cache.has(3), true);
    assert.equal(cache.has(4), true);
  });

  it('should expire entries older than TTL', async () => {
    const ttlMs = 50; // 50ms TTL for testing
    const cache = new BoundedTtlLruCache(10, ttlMs);
    cache.add(999);
    assert.equal(cache.has(999), true);

    // Wait 70ms for entry to expire
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(cache.has(999), false);
  });
});
