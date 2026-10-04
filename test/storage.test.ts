import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PredictionStorageService } from '../src/services/mongodb.js';
import type { FinnhubNewsArticle } from '../src/types/finnhub.js';
import type { JevSentimentResult } from '../src/types/jev.js';

describe('PredictionStorageService (Centralized Prediction Cache)', () => {
  it('should save and retrieve cached predictions (shared weight cache)', async () => {
    const storage = new PredictionStorageService();
    await storage.init();

    const article: FinnhubNewsArticle = {
      category: 'company',
      datetime: Math.floor(Date.now() / 1000),
      headline: 'Tesla Model Y Achieves Highest Safety Rating',
      id: 771122,
      image: '',
      related: 'TSLA',
      source: 'Reuters',
      summary: 'Tesla EV achieved top tier safety scores across all categories.',
      url: 'https://example.com/tsla',
    };

    const classification: JevSentimentResult = {
      sentiment: 1,
      label: 'BULLISH',
      confidence: 0.94,
      probabilities: { bullish: 0.94, bearish: 0.06 },
      rawChoice: 'bullish',
      priority: 'BREAKING_CRITICAL',
      priorityConfidence: 0.96,
      priorityProbabilities: { breaking_critical: 0.92, notable_catalyst: 0.07, routine_noise: 0.01 },
      isBreaking: true,
      urgencyScore: 0.955,
    };

    // Before saving
    const initial = await storage.getCachedPrediction(771122);
    assert.equal(initial, null);

    // Save
    await storage.savePrediction(article, classification);

    // After saving
    const cached = await storage.getCachedPrediction(771122);
    assert.ok(cached);
    assert.equal(cached.sentiment, 1);
    assert.equal(cached.label, 'BULLISH');
    assert.equal(cached.confidence, 0.94);
    assert.equal(cached.symbol, 'TSLA');
    assert.equal(cached.priority, 'BREAKING_CRITICAL');
    assert.equal(cached.isBreaking, true);
    assert.equal(cached.urgencyScore, 0.955);
  });

  it('should correctly rank top stocks by bullish ratio and volume', async () => {
    const storage = new PredictionStorageService();
    await storage.init();

    const makeArticle = (id: number, symbol: string, sentiment: 1 | 0): [FinnhubNewsArticle, JevSentimentResult] => [
      {
        category: 'company',
        datetime: Math.floor(Date.now() / 1000),
        headline: `${symbol} test headline ${id}`,
        id,
        image: '',
        related: symbol,
        source: 'Finnhub',
        summary: 'Summary text',
        url: '',
      },
      {
        sentiment,
        label: sentiment === 1 ? 'BULLISH' : 'BEARISH',
        confidence: 0.9,
        probabilities: { bullish: sentiment === 1 ? 0.9 : 0.1, bearish: sentiment === 1 ? 0.1 : 0.9 },
        rawChoice: sentiment === 1 ? 'bullish' : 'bearish',
        priority: 'NOTABLE_CATALYST',
        priorityConfidence: 0.88,
        priorityProbabilities: { breaking_critical: 0.2, notable_catalyst: 0.7, routine_noise: 0.1 },
        isBreaking: false,
        urgencyScore: 0.55,
      },
    ];

    // NVDA: 2 bullish, 0 bearish -> 100% bullish
    const [a1, c1] = makeArticle(1, 'NVDA', 1);
    const [a2, c2] = makeArticle(2, 'NVDA', 1);
    // AAPL: 1 bullish, 1 bearish -> 50% bullish
    const [a3, c3] = makeArticle(3, 'AAPL', 1);
    const [a4, c4] = makeArticle(4, 'AAPL', 0);

    await storage.savePrediction(a1, c1);
    await storage.savePrediction(a2, c2);
    await storage.savePrediction(a3, c3);
    await storage.savePrediction(a4, c4);

    const top = await storage.getTopStocks(['NVDA', 'AAPL', 'MSFT']);
    assert.equal(top[0]?.symbol, 'NVDA');
    assert.equal(top[0]?.bullishRatio, 1);
    assert.equal(top[1]?.symbol, 'AAPL');
    assert.equal(top[1]?.bullishRatio, 0.5);
  });

  it('should cache and retrieve synthesized ElevenLabs audio buffer', async () => {
    const storage = new PredictionStorageService();
    await storage.init();

    const sampleAudio = Buffer.from('mock-mp3-audio-data-elevenlabs');
    const articleId = 889900;

    // Cache audio
    await storage.saveAudio(articleId, sampleAudio);

    // Retrieve audio
    const retrieved = await storage.getAudio(articleId);
    assert.ok(retrieved);
    assert.equal(retrieved.toString(), 'mock-mp3-audio-data-elevenlabs');
  });

  it('should fetch recent article IDs for warming up deduplicator', async () => {
    const storage = new PredictionStorageService();
    await storage.init();

    const makeArticle = (id: number, symbol: string, sentiment: 1 | 0): [FinnhubNewsArticle, JevSentimentResult] => [
      {
        category: 'company',
        datetime: Math.floor(Date.now() / 1000),
        headline: `${symbol} test headline ${id}`,
        id,
        image: '',
        related: symbol,
        source: 'Finnhub',
        summary: 'Summary text',
        url: '',
      },
      {
        sentiment,
        label: sentiment === 1 ? 'BULLISH' : 'BEARISH',
        confidence: 0.9,
        probabilities: { bullish: sentiment === 1 ? 0.9 : 0.1, bearish: sentiment === 1 ? 0.1 : 0.9 },
        rawChoice: sentiment === 1 ? 'bullish' : 'bearish',
        priority: 'NOTABLE_CATALYST',
        priorityConfidence: 0.88,
        priorityProbabilities: { breaking_critical: 0.2, notable_catalyst: 0.7, routine_noise: 0.1 },
        isBreaking: false,
        urgencyScore: 0.55,
      },
    ];

    const [a1, c1] = makeArticle(101, 'TSLA', 1);
    const [a2, c2] = makeArticle(102, 'TSLA', 0);
    await storage.savePrediction(a1, c1);
    await storage.savePrediction(a2, c2);

    const ids = await storage.getRecentArticleIds(10);
    assert.ok(ids.includes(101));
    assert.ok(ids.includes(102));
  });

  it('should track and retrieve last sync date for incremental fetching', async () => {
    const storage = new PredictionStorageService();
    await storage.init();

    // Initially null for unseeded symbol
    const initial = await storage.getLastSyncDate('GOOGL');
    assert.equal(initial, null);

    // Set sync timestamp (e.g. 10 days ago)
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await storage.setLastSyncDate('GOOGL', tenDaysAgo, 42);

    const retrieved = await storage.getLastSyncDate('GOOGL');
    assert.ok(retrieved);
    assert.equal(retrieved.toISOString(), tenDaysAgo.toISOString());

    // Verify seeded symbols list includes GOOGL
    const seeded = await storage.getSeededSymbols();
    assert.ok(seeded.includes('GOOGL'));
  });

  it('should filter news by multiple interest symbols, date range, and order by impact', async () => {
    const storage = new PredictionStorageService();
    await storage.init();

    const makeArticleWithMeta = (
      id: number,
      symbol: string,
      daysAgo: number,
      urgencyScore: number,
      priority: 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE'
    ): [FinnhubNewsArticle, JevSentimentResult] => [
      {
        category: 'company',
        datetime: Math.floor((Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000),
        headline: `${symbol} test headline ${id}`,
        id,
        image: '',
        related: symbol,
        source: 'Finnhub',
        summary: 'Summary text',
        url: '',
      },
      {
        sentiment: 1,
        label: 'BULLISH',
        confidence: 0.95,
        probabilities: { bullish: 0.95, bearish: 0.05 },
        rawChoice: 'bullish',
        priority,
        priorityConfidence: 0.9,
        priorityProbabilities: { breaking_critical: 0.8, notable_catalyst: 0.15, routine_noise: 0.05 },
        isBreaking: priority === 'BREAKING_CRITICAL',
        urgencyScore,
      },
    ];

    // Article 1: NVDA, 1 day ago, urgency 0.95 (Critical)
    const [a1, c1] = makeArticleWithMeta(201, 'NVDA', 1, 0.95, 'BREAKING_CRITICAL');
    // Article 2: AAPL, 2 days ago, urgency 0.70 (Notable)
    const [a2, c2] = makeArticleWithMeta(202, 'AAPL', 2, 0.70, 'NOTABLE_CATALYST');
    // Article 3: TSLA, 10 days ago (outside 3-day range), urgency 0.99
    const [a3, c3] = makeArticleWithMeta(203, 'TSLA', 10, 0.99, 'BREAKING_CRITICAL');
    // Article 4: MSFT, 1 day ago, urgency 0.20 (Routine)
    const [a4, c4] = makeArticleWithMeta(204, 'MSFT', 1, 0.20, 'ROUTINE_NOISE');

    await storage.savePrediction(a1, c1);
    await storage.savePrediction(a2, c2);
    await storage.savePrediction(a3, c3);
    await storage.savePrediction(a4, c4);

    // 1. Filter by specific multiple interest symbols: ['NVDA', 'AAPL']
    const interestNews = await storage.getRecentNews({
      symbols: ['NVDA', 'AAPL'],
    });
    assert.equal(interestNews.length, 2);
    const symbols = interestNews.map((n) => n.symbol);
    assert.ok(symbols.includes('NVDA'));
    assert.ok(symbols.includes('AAPL'));
    assert.ok(!symbols.includes('TSLA'));
    assert.ok(!symbols.includes('MSFT'));

    // 2. Filter news by 3-day date range (from 3 days ago to today)
    const threeDaysAgoIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!;
    const todayIso = new Date().toISOString().split('T')[0]!;
    const recentNews = await storage.getRecentNews({
      fromDate: threeDaysAgoIso,
      toDate: todayIso,
    });
    // Should include articles within 3 days (201, 202, 204), but NOT article 203 (10 days ago)
    const recentIds = recentNews.map((n) => n._id);
    assert.ok(recentIds.includes(201));
    assert.ok(recentIds.includes(202));
    assert.ok(recentIds.includes(204));
    assert.ok(!recentIds.includes(203));

    // 3. Order by impact (highest urgencyScore first)
    const impactNews = await storage.getRecentNews({
      sortBy: 'impact',
    });
    assert.ok(impactNews.length >= 4);
    // Highest urgency (0.99) should be first
    assert.equal(impactNews[0]?._id, 203);
    assert.equal(impactNews[1]?._id, 201);
  });
});
