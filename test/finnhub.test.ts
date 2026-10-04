import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FinnhubClient } from '../src/services/finnhub.js';

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