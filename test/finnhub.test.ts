import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FinnhubClient } from '../src/services/finnhub.js';

async function flushPromises(): Promise<void> {
  // Drain the fetch, response parsing, and serial queue continuations before advancing timers.
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const quote = { c: 100, pc: 99, d: 1, dp: 1, h: 101, l: 98, o: 99, t: 1791201600 };

describe('Finnhub shared request pacing', () => {
  it('paces concurrent quote and news requests through one queue', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const starts: number[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      starts.push(Date.now());
      return Response.json(url.includes('/quote?') ? quote : []);
    });
    const client = new FinnhubClient('test');
    const requests = Promise.all([
      client.fetchQuote('AAPL'), client.fetchCompanyNews('NVDA'), client.fetchQuote('AMZN'),
    ]);
    await flushPromises();
    assert.deepEqual(starts, [0]);
    t.mock.timers.tick(1199);
    await flushPromises();
    assert.deepEqual(starts, [0]);
    t.mock.timers.tick(1);
    await flushPromises();
    assert.deepEqual(starts, [0, 1200]);
    t.mock.timers.tick(1200);
    await requests;
    assert.deepEqual(starts, [0, 1200, 2400]);
  });

  it('paces news retries and pauses concurrent quotes after a news 429', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const starts: number[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      starts.push(Date.now());
      if (starts.length === 1) return new Response('Too many requests', { status: 429 });
      return Response.json(url.includes('/quote?') ? quote : []);
    });
    const client = new FinnhubClient('test');
    const requests = Promise.all([client.fetchCompanyNews('NVDA'), client.fetchQuote('AMZN')]);
    await flushPromises();
    t.mock.timers.tick(59999);
    await flushPromises();
    assert.deepEqual(starts, [0]);
    t.mock.timers.tick(1);
    await flushPromises();
    assert.deepEqual(starts, [0, 60000]);
    t.mock.timers.tick(1200);
    const [news, price] = await requests;
    assert.deepEqual(starts, [0, 60000, 61200]);
    assert.deepEqual(news, []);
    assert.equal(price?.current, 100);
  });

  for (const [header, cooldown] of [
    [null, 60000], ['0', 60000], ['invalid', 60000], ['90', 90000],
    ['Mon, 05 Oct 2026 12:01:30 GMT', 90000],
  ] as const) {
    it(`shares quote 429 cooldown with news (Retry-After: ${header})`, async (t) => {
      const now = new Date('2026-10-05T12:00:00Z').getTime();
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
      const starts: number[] = [];
      t.mock.method(globalThis, 'fetch', async () => {
        starts.push(Date.now() - now);
        if (starts.length === 1) {
          return new Response('Too many requests', {
            status: 429, headers: header === null ? {} : { 'Retry-After': header },
          });
        }
        return Response.json([]);
      });
      const client = new FinnhubClient('test');
      const requests = Promise.all([client.fetchQuote('AAPL'), client.fetchCompanyNews('NVDA')]);
      await flushPromises();
      t.mock.timers.tick(cooldown - 1);
      await flushPromises();
      assert.deepEqual(starts, [0]);
      t.mock.timers.tick(1);
      await requests;
      assert.deepEqual(starts, [0, cooldown]);
    });
  }

  it('continues processing the queue after a network failure', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json([]));
    fetchMock.mock.mockImplementationOnce(async () => { throw new Error('Network failed'); });
    const client = new FinnhubClient('test');
    const failedQuote = client.fetchQuote('AAPL');
    const news = client.fetchCompanyNews('NVDA');
    await flushPromises();
    assert.equal(await failedQuote, null);
    t.mock.timers.tick(1200);
    assert.deepEqual(await news, []);
    assert.equal(fetchMock.mock.callCount(), 2);
  });
});

describe('Finnhub news sync responses', () => {
  it('accepts an empty successful query with the requested date range', async (t) => {
    t.mock.method(globalThis, 'fetch', async (input: string) => {
      const url = new URL(input);
      assert.equal(url.searchParams.get('from'), '2025-10-05');
      assert.equal(url.searchParams.get('to'), '2026-10-02');
      return Response.json([]);
    });
    assert.deepEqual(await new FinnhubClient('test').fetchCompanyNews('AAPL', '2025-10-05', '2026-10-02'), []);
  });

  for (const [name, response, error] of [
    ['forbidden requests', () => new Response('Forbidden', { status: 403 }), /403 Forbidden/],
    ['invalid response bodies', () => Response.json({ error: 'Unavailable' }), /non-array news response/],
  ] as const) {
    it(`rejects ${name} instead of reporting a successfully synced empty range`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => response());
      await assert.rejects(new FinnhubClient('test').fetchCompanyNews('AAPL', '2025-10-05', '2026-10-02'), error);
    });
  }
});