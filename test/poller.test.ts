import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NewsAlertPoller } from '../src/scheduler/poller.js';
import { PredictionStorageService } from '../src/services/mongodb.js';
import { FinnhubClient } from '../src/services/finnhub.js';
import { JevClassificationService } from '../src/services/jev.js';
import { TelegramAlertService } from '../src/services/telegram.js';
import { ElevenLabsService } from '../src/services/elevenlabs.js';
import { BoundedTtlLruCache } from '../src/cache/lru.js';
import type { FinnhubNewsArticle } from '../src/types/finnhub.js';
import type { JevSentimentResult } from '../src/types/jev.js';

const result: JevSentimentResult = {
  sentiment: 1, label: 'BULLISH', confidence: 0.95,
  probabilities: { bullish: 0.95, bearish: 0.05 }, rawChoice: 'bullish',
  priority: 'BREAKING_CRITICAL', priorityConfidence: 0.95,
  priorityProbabilities: { breaking_critical: 0.95, notable_catalyst: 0.04, routine_noise: 0.01 },
  isBreaking: true, urgencyScore: 0.97,
};

function article(id: number, date: string): FinnhubNewsArticle {
  return {
    id, datetime: new Date(date).getTime() / 1000, related: 'AAPL',
    category: 'company', headline: `News ${id}`, summary: 'Test news',
    source: 'Test', image: '', url: 'https://example.com/news',
  };
}

function setup(t: TestContext, storage = new PredictionStorageService(), historySyncDays = 7) {
  const finnhub = new FinnhubClient('test');
  const jev = new JevClassificationService('test');
  const telegram = new TelegramAlertService('test', 'test');
  const fetchNews = t.mock.method(finnhub, 'fetchCompanyNews', async () => [] as FinnhubNewsArticle[]);
  t.mock.method(finnhub, 'fetchQuote', async () => null);
  const classify = t.mock.method(jev, 'classifyArticleSentiment', async () => result);
  const sendAlert = t.mock.method(telegram, 'sendAlert', async () => {});
  const poller = new NewsAlertPoller({
    watchlist: ['AAPL'], pollIntervalMs: 2000, minConfidence: 0.5, enableVoiceAlerts: false,
    finnhubClient: finnhub, jevService: jev, telegramService: telegram, storage,
    elevenlabsService: new ElevenLabsService(), deduplicator: new BoundedTtlLruCache(),
    initialSeededSymbols: ['AAPL'], historySyncDays,
  });
  // Exercise one scheduler iteration without starting a background timer.
  Object.assign(poller, { isRunning: true });
  return { poller, telegram, storage, fetchNews, classify, sendAlert, tick: () => poller['tick']() };
}

describe('Breaking-only Telegram voice', () => {
  for (const priority of ['BREAKING_CRITICAL', 'NOTABLE_CATALYST'] as const) {
    it(`delivers ${priority} via the correct voice or text channel`, async (t) => {
      const storage = new PredictionStorageService();
      await storage.setSyncRange('AAPL', '2025-01-01', new Date().toISOString().split('T')[0]!, 0, new Date(), true);
      const s = setup(t, storage);
      const elevenlabs = new ElevenLabsService('test');
      Object.assign(s.poller, { enableVoiceAlerts: true, elevenlabsService: elevenlabs });
      s.fetchNews.mock.mockImplementation(async () => [article(77, new Date().toISOString())]);
      s.classify.mock.mockImplementation(async () => ({ ...result, priority }));
      const generate = t.mock.method(elevenlabs, 'generateAlertVoice', async () => Buffer.from('voice'));
      const voice = t.mock.method(s.telegram, 'sendVoiceAlert', async () => {});
      await s.tick();
      assert.equal(generate.mock.callCount(), priority === 'BREAKING_CRITICAL' ? 1 : 0);
      assert.equal(voice.mock.callCount(), priority === 'BREAKING_CRITICAL' ? 1 : 0);
      assert.equal(s.sendAlert.mock.callCount(), priority === 'NOTABLE_CATALYST' ? 1 : 0);
    });
  }
});

describe('NewsAlertPoller scheduling', () => {
  it('waits a full interval after a slow tick instead of catching up in a burst', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    const { poller } = setup(t);
    poller.stop();
    const scheduler = poller as unknown as { tick(): Promise<void> };
    const tick = t.mock.method(scheduler, 'tick', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    });
    t.after(() => poller.stop());
    poller.start();
    t.mock.timers.tick(2000);
    assert.equal(tick.mock.callCount(), 1);
    t.mock.timers.tick(5000);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    t.mock.timers.tick(1999);
    assert.equal(tick.mock.callCount(), 1);
    t.mock.timers.tick(1);
    assert.equal(tick.mock.callCount(), 2);
  });
});

describe('NewsAlertPoller sync coverage', () => {
  it('uses zero-day live alerts without Mongo backfill or downtime history', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const s = setup(t, undefined, 0);
    await s.storage.savePrediction(article(320, '2026-10-05T01:00:00Z'), result);
    delete (await s.storage.getCachedPrediction(320))!.evaluatedBy;
    const pending = t.mock.method(s.storage, 'getRecentNews');
    s.fetchNews.mock.mockImplementation(async () => [
      article(321, '2026-10-05T11:00:00Z'), article(322, '2026-10-04T23:00:00Z'),
      article(323, '2026-10-06'),
    ]);
    await s.tick();
    assert.equal(pending.mock.callCount(), 0);
    assert.equal(s.classify.mock.callCount(), 1);
    assert.equal(s.sendAlert.mock.callCount(), 1);
    assert.equal((await s.storage.getCachedPrediction(320))?.evaluatedBy, undefined);
    assert.equal(await s.storage.getCachedPrediction(322), null);
    assert.equal(await s.storage.getCachedPrediction(323), null);
    await s.storage.setSyncRange('AAPL', '2026-09-01', '2026-09-02');
    await s.tick();
    assert.equal(s.classify.mock.callCount(), 1);
    assert.equal(s.sendAlert.mock.callCount(), 1);
    for (const call of s.fetchNews.mock.calls) {
      assert.deepEqual(call.arguments, ['AAPL', '2026-10-05', '2026-10-05']);
    }
  });

  it('evaluates unverified Mongo news once on cold start without Finnhub or alerts', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const s = setup(t);
    for (const item of [article(300, '2026-10-05T11:00:00Z'),
      article(301, '2026-09-01'), article(302, '2026-10-04'),
      article(303, '2026-10-06'), { ...article(304, '2026-10-04'), related: 'MSFT' }]) {
      await s.storage.savePrediction(item, result);
      if (item.id !== 302) delete (await s.storage.getCachedPrediction(item.id))!.evaluatedBy;
    }
    await s.storage.setSyncRange('AAPL', '2026-09-28', '2026-10-05', 0, new Date(), true);
    await s.tick();
    assert.equal(s.classify.mock.callCount(), 1);
    const evaluated = s.classify.mock.calls[0]?.arguments[0];
    assert.ok(evaluated);
    assert.equal(evaluated.id, 300);
    assert.equal((await s.storage.getCachedPrediction(300))?.evaluatedBy, 'jev');
    for (const id of [301, 303, 304]) assert.equal((await s.storage.getCachedPrediction(id))?.evaluatedBy, undefined);
    assert.equal(s.sendAlert.mock.callCount(), 0);
    await s.tick();
    assert.equal(s.classify.mock.callCount(), 1);
  });

  it('retries cold-start inference and writes, reusing completed records after restart', async (t) => {
    const s = setup(t);
    for (const id of [310, 311]) {
      await s.storage.savePrediction(article(id, new Date(Date.now() - (312 - id) * 1000).toISOString()), result);
      delete (await s.storage.getCachedPrediction(id))!.evaluatedBy;
    }
    s.classify.mock.mockImplementationOnce(async () => { throw new Error('Jev unavailable'); });
    await s.tick();
    assert.equal((await s.storage.getCachedPrediction(310))?.evaluatedBy, undefined);
    assert.equal((await s.storage.getCachedPrediction(311))?.evaluatedBy, 'jev');
    const save = t.mock.method(s.storage, 'savePrediction', async () => { throw new Error('Mongo unavailable'); });
    await s.tick();
    assert.equal((await s.storage.getCachedPrediction(310))?.evaluatedBy, undefined);
    save.mock.restore();
    const restarted = setup(t, s.storage);
    await restarted.tick();
    assert.equal(restarted.classify.mock.callCount(), 1);
    assert.equal((await s.storage.getCachedPrediction(310))?.evaluatedBy, 'jev');
    assert.equal(s.sendAlert.mock.callCount(), 0);
    assert.equal(restarted.sendAlert.mock.callCount(), 0);
  });

  it('evaluates every historical article, repairs legacy labels, and stays silent', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const s = setup(t, undefined, 365); // Constructor also caps direct callers.
    const articles = Array.from({ length: 6 }, (_, i) => article(i + 100, '2026-10-04'));
    await s.storage.savePrediction(articles[0]!, result);
    const legacy = await s.storage.getCachedPrediction(100);
    delete legacy!.evaluatedBy;
    await s.storage.setSyncRange('AAPL', '2025-10-05', '2026-10-05');
    s.fetchNews.mock.mockImplementation(async () => articles);
    await s.tick();
    assert.deepEqual(s.fetchNews.mock.calls[0]?.arguments, ['AAPL', '2026-09-28', '2026-10-05']);
    assert.equal(s.classify.mock.callCount(), 6);
    assert.equal(s.sendAlert.mock.callCount(), 0);
    for (const item of articles) {
      assert.equal((await s.storage.getCachedPrediction(item.id))?.evaluatedBy, 'jev');
    }
    assert.equal((await s.storage.getSyncMetadata('AAPL'))?.evaluatedAll, true);
    await s.tick();
    assert.equal(s.classify.mock.callCount(), 6);
  });

  it('retries failed historical inference without storing placeholders or advancing coverage', async (t) => {
    const s = setup(t);
    s.fetchNews.mock.mockImplementation(async () => [article(200, new Date().toISOString()), article(201, new Date().toISOString())]);
    s.classify.mock.mockImplementationOnce(async () => { throw new Error('Jev unavailable'); });
    await s.tick();
    assert.equal(await s.storage.getCachedPrediction(200), null);
    assert.ok(await s.storage.getCachedPrediction(201));
    assert.equal(await s.storage.getSyncMetadata('AAPL'), null);
    await s.tick();
    assert.ok(await s.storage.getCachedPrediction(200));
    assert.equal(s.classify.mock.callCount(), 3);
    assert.equal(s.sendAlert.mock.callCount(), 0);
    assert.equal((await s.storage.getSyncMetadata('AAPL'))?.evaluatedAll, true);
  });

  it('archives watched daily prices without dashboard traffic and still processes news if prices fail', async (t) => {
    const s = setup(t);
    const calls: string[] = [];
    Object.assign(s.poller, { priceHistoryService: { async get(symbol: string, range: string) {
      calls.push(`${symbol}:${range}`);
      throw new Error('Price provider unavailable');
    } } });
    await s.tick();
    assert.deepEqual(calls, ['AAPL:max']);
    assert.equal(s.fetchNews.mock.callCount(), 1);
    assert.ok(await s.storage.getSyncMetadata('AAPL'));
  });
  it('backfills only missing older history after changing 3 days to 7 on restart', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const initial = setup(t, undefined, 3);
    initial.fetchNews.mock.mockImplementation(async () => [article(1, '2026-10-02')]);
    await initial.tick();
    assert.deepEqual(initial.fetchNews.mock.calls[0]?.arguments, ['AAPL', '2026-10-02', '2026-10-05']);

    const restarted = setup(t, initial.storage);
    restarted.fetchNews.mock.mockImplementation(async () => [article(1, '2026-10-02'), article(2, '2026-09-29')]);
    await restarted.tick();
    assert.deepEqual(restarted.fetchNews.mock.calls[0]?.arguments, ['AAPL', '2026-09-28', '2026-10-02']);
    const metadata = await restarted.storage.getSyncMetadata('AAPL');
    assert.equal(metadata?.syncedFrom, '2026-09-28');
    assert.equal(metadata?.syncedTo, '2026-10-05');
    assert.ok(await restarted.storage.getCachedPrediction(2));
    assert.equal(restarted.classify.mock.callCount(), 1); // Cached article 1 is reused.
    assert.equal(restarted.sendAlert.mock.callCount(), 0);

    await restarted.tick();
    assert.deepEqual(restarted.fetchNews.mock.calls[1]?.arguments, ['AAPL', '2026-10-04', '2026-10-05']);
  });

  it('records successful empty ranges even when startup says the symbol is already seeded', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const s = setup(t);
    await s.tick();
    assert.deepEqual(s.fetchNews.mock.calls[0]?.arguments, ['AAPL', '2026-09-28', '2026-10-05']);
    assert.equal((await s.storage.getSyncMetadata('AAPL'))?.syncedFrom, '2026-09-28');
    await s.tick();
    assert.deepEqual(s.fetchNews.mock.calls[1]?.arguments, ['AAPL', '2026-10-04', '2026-10-05']);
  });

  it('re-seeds legacy timestamp-only metadata without inferring coverage from articles', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const s = setup(t);
    t.mock.method(s.storage, 'getSyncMetadata', async () => ({
      _id: 'AAPL', lastSyncedAt: '2026-10-05T11:00:00Z', articlesCount: 10,
    }));
    await s.tick();
    assert.deepEqual(s.fetchNews.mock.calls[0]?.arguments, ['AAPL', '2026-09-28', '2026-10-05']);
    assert.equal(s.sendAlert.mock.callCount(), 0);
  });

  it('keeps wider coverage when reducing history and catches up downtime on the next tick', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const storage = new PredictionStorageService();
    await storage.setSyncRange('AAPL', '2025-10-05', '2026-09-25', 0, new Date(), true);
    const s = setup(t, storage, 3);
    await s.tick();
    assert.deepEqual(s.fetchNews.mock.calls[0]?.arguments, ['AAPL', '2026-10-02', '2026-10-05']);
    assert.equal((await storage.getSyncMetadata('AAPL'))?.syncedFrom, '2025-10-05');
    assert.equal((await storage.getSyncMetadata('AAPL'))?.syncedTo, '2026-10-05');
  });

  it('does not advance history coverage after failed fetches or storage writes, and retries', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const storage = new PredictionStorageService();
    await storage.setSyncRange('AAPL', '2026-10-02', '2026-10-05', 0, new Date(), true);
    const before = await storage.getSyncMetadata('AAPL');
    const s = setup(t, storage);
    s.fetchNews.mock.mockImplementationOnce(async () => { throw new Error('Fetch failed'); });
    await s.tick();
    assert.deepEqual(await storage.getSyncMetadata('AAPL'), before);

    s.fetchNews.mock.mockImplementation(async () => [article(3, '2026-09-29')]);
    const save = t.mock.method(storage, 'savePrediction', async () => { throw new Error('Write failed'); });
    await s.tick();
    assert.deepEqual(await storage.getSyncMetadata('AAPL'), before);
    save.mock.restore();
    await s.tick();
    assert.equal((await storage.getSyncMetadata('AAPL'))?.syncedFrom, '2026-09-28');
    assert.ok(await storage.getCachedPrediction(3));
    assert.equal(s.sendAlert.mock.callCount(), 0);
    for (const call of s.fetchNews.mock.calls) {
      assert.deepEqual(call.arguments, ['AAPL', '2026-09-28', '2026-10-02']);
    }
  });

  it('retries failed live storage writes without skipping articles in the deduplicator', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00Z') });
    const storage = new PredictionStorageService();
    await storage.setSyncRange('AAPL', '2025-10-05', '2026-10-04', 0, new Date(), true);
    const before = await storage.getSyncMetadata('AAPL');
    const s = setup(t, storage);
    s.fetchNews.mock.mockImplementation(async () => [article(4, '2026-10-05T11:00:00Z')]);
    const save = t.mock.method(storage, 'savePrediction', async () => { throw new Error('Write failed'); });
    await s.tick();
    assert.deepEqual(await storage.getSyncMetadata('AAPL'), before);
    save.mock.restore();
    await s.tick();
    assert.ok(await storage.getCachedPrediction(4));
    assert.equal((await storage.getSyncMetadata('AAPL'))?.syncedTo, '2026-10-05');
    assert.equal(s.sendAlert.mock.callCount(), 1);
  });
});