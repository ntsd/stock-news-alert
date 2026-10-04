import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PredictionStorageService } from '../src/services/mongodb.js';
import { PriceHistoryService } from '../src/services/priceHistory.js';
import { FinnhubClient } from '../src/services/finnhub.js';

const now = new Date('2026-10-05T12:00:00Z').getTime();
const candles = [
  { timestamp: now - 86400000, price: 100.123456, open: 99, high: 101, low: 98, close: 100.123456, volume: 1234, adjustedClose: 98.54321 },
  { timestamp: now, price: 102, open: 100, high: 103, low: 99, close: 102, volume: 5678, adjustedClose: 101 },
];

describe('Durable candle storage', () => {
  it('upserts overlapping bars while retaining older dates and separate resolutions', async () => {
    const storage = new PredictionStorageService();
    await storage.savePriceCandles('aapl', '1d', candles, now);
    await storage.savePriceCandles('AAPL', '1d', [{ ...candles[1]!, price: 103, close: 103 }], now + 1);
    await storage.savePriceCandles('AAPL', '15m', [candles[1]!], now);
    const daily = await storage.getPriceCandles('aapl', '1d', 0, now);
    assert.equal(daily.length, 2);
    assert.equal(daily[0]!.price, 100.123456);
    assert.equal(daily[0]!.adjustedClose, 98.54321);
    assert.equal(daily[1]!.close, 103);
    assert.equal((await storage.getPriceCandles('AAPL', '15m', 0, now)).length, 1);
    assert.equal((await storage.getPriceCandles('MSFT', '1d', 0, now)).length, 0);
    assert.equal((await storage.getPriceCandles('AAPL', '1d', now, now)).length, 1);
  });

  it('writes idempotent Mongo candle upserts and reads them after restart', async () => {
    const documents = new Map<string, any>();
    const collection = {
      async bulkWrite(operations: any[], options: unknown) {
        assert.deepEqual(options, { ordered: false });
        for (const { updateOne: op } of operations) {
          assert.equal(op.upsert, true);
          assert.equal(op.filter._id, op.update.$set._id);
          documents.set(op.filter._id, op.update.$set);
        }
      },
      find(query: any) {
        assert.equal(query.symbol, 'AAPL');
        assert.equal(query.interval, '1d');
        assert.deepEqual(query.timestamp, { $gte: 0, $lte: now });
        return { sort(order: unknown) {
          assert.deepEqual(order, { timestamp: 1 });
          return { async toArray() { return [...documents.values()].sort((a, b) => a.timestamp - b.timestamp); } };
        } };
      },
    };
    const storage = new PredictionStorageService();
    Object.assign(storage, { priceCollection: collection });
    await storage.savePriceCandles('aapl', '1d', [...candles, candles[0]!], now);
    await storage.savePriceCandles('AAPL', '1d', candles, now + 1);
    assert.equal(documents.size, 2);
    assert.equal(documents.get(`AAPL:1d:${now}`)?.provider, 'yahoo');
    const restarted = new PredictionStorageService();
    Object.assign(restarted, { priceCollection: collection });
    assert.deepEqual(await restarted.getPriceCandles('AAPL', '1d', 0, now), candles);
  });

  it('rejects invalid bars before writing anything', async () => {
    const storage = new PredictionStorageService();
    await assert.rejects(storage.savePriceCandles('AAPL', '1d', [candles[0]!, { timestamp: now, price: NaN }]), /Invalid price candle/);
    assert.deepEqual(await storage.getPriceCandles('AAPL', '1d', 0, now), []);
  });

  it('persists fetch metadata independently of news coverage and reads it after restart', async () => {
    let document: any = null;
    const collection = {
      async updateOne(filter: any, update: any, options: any) {
        assert.deepEqual(filter, { _id: 'AAPL:max' });
        assert.deepEqual(options, { upsert: true });
        document = update.$set;
      },
      async findOne(filter: any) {
        assert.deepEqual(filter, { _id: 'AAPL:max' });
        return document;
      },
    };
    const metadata = { _id: 'AAPL:max', symbol: 'AAPL', range: 'max', interval: '1d' as const, fetchedAt: now, from: candles[0]!.timestamp, to: now };
    const storage = new PredictionStorageService();
    Object.assign(storage, { priceMetadataCollection: collection });
    await storage.savePriceHistoryMetadata(metadata);
    const restarted = new PredictionStorageService();
    Object.assign(restarted, { priceMetadataCollection: collection });
    assert.deepEqual(await restarted.getPriceHistoryMetadata('aapl', 'max'), metadata);
    assert.equal(await restarted.getSyncMetadata('AAPL'), null);
  });
});

describe('Price history cache and archive', () => {
  it('deduplicates concurrent requests, survives service restart, and refreshes after five minutes', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const storage = new PredictionStorageService();
    let requests = 0;
    const client = { async fetchPriceHistory(symbol: string, range: string) {
      assert.equal(symbol, 'AAPL'); assert.equal(range, '7d');
      requests++; return candles;
    } };
    const service = new PriceHistoryService(storage, client);
    const [first, second] = await Promise.all([service.get('aapl'), service.get('AAPL')]);
    assert.deepEqual(first, second);
    assert.equal(requests, 1);
    await service.get('AAPL');
    const restarted = new PriceHistoryService(storage, client);
    assert.deepEqual(await restarted.get('AAPL'), first);
    assert.equal(requests, 1);
    t.mock.timers.tick(300001);
    await restarted.get('AAPL');
    assert.equal(requests, 2);
  });

  it('reconciles full daily history once a day, including provider corrections', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const storage = new PredictionStorageService();
    const calls: string[] = [];
    const service = new PriceHistoryService(storage, { async fetchPriceHistory(symbol, range) {
      calls.push(`${symbol}:${range}`);
      return calls.length === 1 ? candles : [{ ...candles[0]!, adjustedClose: 97 }, candles[1]!];
    } });
    await service.get('AAPL', 'max');
    await service.get('AAPL', 'max');
    assert.deepEqual(calls, ['AAPL:max']);
    t.mock.timers.tick(86400001);
    await service.get('AAPL', 'max');
    assert.deepEqual(calls, ['AAPL:max', 'AAPL:max']);
    assert.equal((await storage.getPriceCandles('AAPL', '1d'))[0]!.adjustedClose, 97);
  });

  it('returns labeled stale data on failure without advancing the persisted checkpoint', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const storage = new PredictionStorageService();
    await new PriceHistoryService(storage, { fetchPriceHistory: async () => candles }).get('AAPL');
    t.mock.timers.tick(300001);
    let requests = 0;
    const service = new PriceHistoryService(storage, { async fetchPriceHistory() { requests++; return []; } });
    const stale = await service.get('AAPL');
    assert.equal(stale.stale, true);
    assert.equal(stale.fetchedAt, now);
    assert.deepEqual(stale.candles, candles);
    assert.equal((await storage.getPriceHistoryMetadata('AAPL', '7d'))?.fetchedAt, now);
    await service.get('AAPL');
    assert.equal(requests, 1);
    t.mock.timers.tick(60001);
    await service.get('AAPL');
    assert.equal(requests, 2);
  });

  it('still serves genuine provider data when Mongo writes fail, but retries persistence', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const storage = new PredictionStorageService();
    Object.assign(storage, { priceCollection: { async bulkWrite() { throw new Error('Mongo unavailable'); } } });
    let requests = 0;
    const service = new PriceHistoryService(storage, { async fetchPriceHistory() { requests++; return candles; } });
    assert.deepEqual((await service.get('AAPL')).candles, candles);
    assert.equal(await storage.getPriceHistoryMetadata('AAPL', '7d'), null);
    t.mock.timers.tick(60001);
    Object.assign(storage, { priceCollection: null });
    await service.get('AAPL');
    assert.equal(requests, 2);
    assert.ok(await storage.getPriceHistoryMetadata('AAPL', '7d'));
  });

  it('does not cache successful metadata or fabricated history after an invalid/empty provider response', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    for (const response of [[], [{ timestamp: now, price: Infinity }]]) {
      const storage = new PredictionStorageService();
      const service = new PriceHistoryService(storage, { fetchPriceHistory: async () => response });
      assert.deepEqual(await service.get('AAPL'), { candles: [], stale: true, fetchedAt: null });
      assert.equal(await storage.getPriceHistoryMetadata('AAPL', '7d'), null);
      assert.deepEqual(await storage.getPriceCandles('AAPL', '1h'), []);
    }
  });

  it('retries a failed metadata checkpoint without losing fetched candles', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const storage = new PredictionStorageService();
    const checkpoint = t.mock.method(storage, 'savePriceHistoryMetadata', async () => { throw new Error('Checkpoint failed'); });
    let requests = 0;
    const service = new PriceHistoryService(storage, { async fetchPriceHistory() { requests++; return candles; } });
    assert.deepEqual((await service.get('AAPL')).candles, candles);
    assert.equal(await storage.getPriceHistoryMetadata('AAPL', '7d'), null);
    assert.equal((await storage.getPriceCandles('AAPL', '1h')).length, 2);
    t.mock.timers.tick(60001);
    checkpoint.mock.restore();
    await service.get('AAPL');
    assert.equal(requests, 2);
    assert.ok(await storage.getPriceHistoryMetadata('AAPL', '7d'));
  });

  it('bounds chart cache entries and validates request keys', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now });
    const service = new PriceHistoryService(new PredictionStorageService(), { fetchPriceHistory: async () => candles });
    for (let i = 0; i <= 100; i++) await service.get(`T${i}`);
    assert.equal(service['cache'].size, 100);
    assert.equal(service['cache'].has('T0:7d'), false);
    await assert.rejects(service.get('bad/symbol'), /Invalid/);
    await assert.rejects(service.get('AAPL', 'invalid'), /Invalid/);
  });
});

describe('Yahoo candle provenance', () => {
  it('fetches full daily history without rounding OHLC or adjusted closes', async (t) => {
    t.mock.method(globalThis, 'fetch', async (input: string) => {
      const url = new URL(input);
      assert.equal(url.searchParams.get('interval'), '1d');
      assert.equal(url.searchParams.get('period1'), '0');
      return Response.json({ chart: { result: [{
        meta: { dataGranularity: '1d' }, timestamp: [now / 1000],
        indicators: { quote: [{ close: [100.123456], open: [99.123456], high: [101], low: [98], volume: [1234] }], adjclose: [{ adjclose: [98.54321] }] },
      }] } });
    });
    const points = await new FinnhubClient('test').fetchPriceHistory('AAPL', 'max');
    assert.equal(points[0]!.price, 100.123456);
    assert.equal(points[0]!.open, 99.123456);
    assert.equal(points[0]!.adjustedClose, 98.54321);
  });

  it('returns no candles on provider failure instead of generating a quote-based curve', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('Unavailable', { status: 503 }));
    assert.deepEqual(await new FinnhubClient('test').fetchPriceHistory('AAPL'), []);
    assert.equal(fetch.mock.callCount(), 1);
  });

  it('rejects unexpected provider granularity instead of archiving mislabeled bars', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ chart: { result: [{ meta: { dataGranularity: '3mo' } }] } }));
    assert.deepEqual(await new FinnhubClient('test').fetchPriceHistory('AAPL', 'max'), []);
  });
});