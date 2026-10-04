import { MongoClient, type Collection, type Db } from 'mongodb';
import type { FinnhubNewsArticle } from '../types/finnhub.js';
import type { JevSentimentResult } from '../types/jev.js';
import { traceSpan } from '../instrumentation/sentry.js';

export interface StoredArticle {
  _id: number; // Article ID
  symbol: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
  sentiment: 1 | 0;
  label: 'BULLISH' | 'BEARISH';
  confidence: number;
  probabilities: {
    bullish: number;
    bearish: number;
  };
  rawChoice: 'bullish' | 'bearish';
  createdAt: string;
  audioBase64?: string; // Cached ElevenLabs MP3

  // Unified Priority & Urgency
  priority: 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE';
  priorityConfidence: number;
  isBreaking: boolean;
  urgencyScore: number;
}

export interface StockAggregate {
  symbol: string;
  totalArticles: number;
  bullishCount: number;
  bearishCount: number;
  bullishRatio: number;
  avgConfidence: number;
  lastSignal: 1 | 0;
  lastLabel: 'BULLISH' | 'BEARISH';
  lastHeadline: string;
  lastUpdated: string;
}

export class PredictionStorageService {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<StoredArticle> | null = null;
  private readonly memoryStore = new Map<number, StoredArticle>();

  constructor(
    private readonly uri?: string,
    private readonly dbName = 'stock_news_alert'
  ) {}

  public async init(): Promise<void> {
    if (!this.uri) {
      console.log('ℹ️ [MongoDB] MONGODB_URI not configured. Running with in-memory centralized prediction store.');
      return;
    }

    try {
      console.log(`🔌 [MongoDB] Connecting to MongoDB at ${this.uri.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}...`);
      this.client = new MongoClient(this.uri, {
        connectTimeoutMS: 5000,
        serverSelectionTimeoutMS: 5000,
      });
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.collection = this.db.collection<StoredArticle>('predictions');

      // Create indexes for efficient querying and aggregation
      await this.collection.createIndex({ symbol: 1, publishedAt: -1 });
      await this.collection.createIndex({ createdAt: -1 });
      await this.collection.createIndex({ sentiment: 1 });
      await this.collection.createIndex({ urgencyScore: -1 });
      await this.collection.createIndex({ priority: 1 });

      console.log('✅ [MongoDB] Connected to centralized MongoDB cluster.');
    } catch (err) {
      console.warn('⚠️ [MongoDB] Connection failed. Falling back to internal memory prediction store:', err instanceof Error ? err.message : err);
      this.client = null;
      this.collection = null;
    }
  }

  /**
   * Check if a prediction is already cached in centralized storage.
   */
  public async getCachedPrediction(id: number): Promise<StoredArticle | null> {
    return traceSpan('mongo.get_cached_prediction', 'db.cache', { id }, async () => {
      if (this.collection) {
        return await this.collection.findOne({ _id: id });
      }
      return this.memoryStore.get(id) || null;
    });
  }

  /**
   * Persists an article with its Jev System 1 classification into centralized storage.
   */
  public async savePrediction(
    article: FinnhubNewsArticle,
    classification: JevSentimentResult
  ): Promise<void> {
    const doc: StoredArticle = {
      _id: article.id,
      symbol: article.related,
      headline: article.headline,
      summary: article.summary,
      source: article.source,
      url: article.url,
      publishedAt: new Date(article.datetime * 1000).toISOString(),
      sentiment: classification.sentiment,
      label: classification.label,
      confidence: classification.confidence,
      probabilities: classification.probabilities,
      rawChoice: classification.rawChoice,
      createdAt: new Date().toISOString(),
      priority: classification.priority,
      priorityConfidence: classification.priorityConfidence,
      isBreaking: classification.isBreaking,
      urgencyScore: classification.urgencyScore,
    };

    // Always update local memory store
    this.memoryStore.set(article.id, doc);

    if (this.collection) {
      await traceSpan('mongo.save_prediction', 'db.write', { id: article.id, symbol: article.related }, async () => {
        await this.collection!.updateOne(
          { _id: article.id },
          { $set: doc },
          { upsert: true }
        );
      });
    }
  }

  /**
   * Fetches recent news articles ordered by publication date or urgency score.
   */
  public async getRecentNews(
    limit = 50,
    symbol?: string,
    sentiment?: 1 | 0,
    priority?: 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE',
    breakingOnly = false
  ): Promise<StoredArticle[]> {
    if (this.collection) {
      const query: Record<string, unknown> = {};
      if (symbol) query['symbol'] = symbol.toUpperCase();
      if (sentiment !== undefined) query['sentiment'] = sentiment;
      if (priority) query['priority'] = priority;
      if (breakingOnly) query['isBreaking'] = true;

      return await this.collection
        .find(query)
        .sort({ publishedAt: -1, createdAt: -1 })
        .limit(limit)
        .toArray();
    }

    // Fallback: query memory store
    let items = Array.from(this.memoryStore.values());
    if (symbol) {
      items = items.filter((item) => item.symbol.toUpperCase() === symbol.toUpperCase());
    }
    if (sentiment !== undefined) {
      items = items.filter((item) => item.sentiment === sentiment);
    }
    if (priority) {
      items = items.filter((item) => item.priority === priority);
    }
    if (breakingOnly) {
      items = items.filter((item) => item.isBreaking);
    }

    return items
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
      .slice(0, limit);
  }

  /**
   * Aggregates and ranks watched stocks by bullish ratio and news volume.
   */
  public async getTopStocks(watchlist: string[]): Promise<StockAggregate[]> {
    const allArticles = this.collection
      ? await this.collection.find({}).toArray()
      : Array.from(this.memoryStore.values());

    const map = new Map<string, {
      total: number;
      bullish: number;
      bearish: number;
      confidenceSum: number;
      lastSignal: 1 | 0;
      lastLabel: 'BULLISH' | 'BEARISH';
      lastHeadline: string;
      lastUpdated: string;
    }>();

    // Initialize with watchlist tickers
    for (const sym of watchlist) {
      map.set(sym, {
        total: 0,
        bullish: 0,
        bearish: 0,
        confidenceSum: 0,
        lastSignal: 1,
        lastLabel: 'BULLISH',
        lastHeadline: 'Awaiting breaking news...',
        lastUpdated: new Date().toISOString(),
      });
    }

    // Populate stats
    for (const art of allArticles) {
      const sym = art.symbol.toUpperCase();
      if (!map.has(sym)) {
        map.set(sym, {
          total: 0,
          bullish: 0,
          bearish: 0,
          confidenceSum: 0,
          lastSignal: art.sentiment,
          lastLabel: art.label,
          lastHeadline: art.headline,
          lastUpdated: art.publishedAt,
        });
      }

      const entry = map.get(sym)!;
      entry.total++;
      if (art.sentiment === 1) entry.bullish++;
      else entry.bearish++;
      entry.confidenceSum += art.confidence;

      if (new Date(art.publishedAt).getTime() > new Date(entry.lastUpdated).getTime()) {
        entry.lastSignal = art.sentiment;
        entry.lastLabel = art.label;
        entry.lastHeadline = art.headline;
        entry.lastUpdated = art.publishedAt;
      }
    }

    const result: StockAggregate[] = [];
    for (const [symbol, stats] of map.entries()) {
      const bullishRatio = stats.total > 0 ? stats.bullish / stats.total : 0.5;
      const avgConfidence = stats.total > 0 ? stats.confidenceSum / stats.total : 0;

      result.push({
        symbol,
        totalArticles: stats.total,
        bullishCount: stats.bullish,
        bearishCount: stats.bearish,
        bullishRatio,
        avgConfidence,
        lastSignal: stats.lastSignal,
        lastLabel: stats.lastLabel,
        lastHeadline: stats.lastHeadline,
        lastUpdated: stats.lastUpdated,
      });
    }

    // Order top stocks by: 1) Bullish ratio descending, 2) Total articles descending
    return result.sort((a, b) => {
      if (b.bullishRatio !== a.bullishRatio) {
        return b.bullishRatio - a.bullishRatio;
      }
      return b.totalArticles - a.totalArticles;
    });
  }

  /**
   * Caches an ElevenLabs synthesized MP3 audio buffer in MongoDB to eliminate redundant TTS API costs.
   */
  public async saveAudio(id: number, audioBuffer: Buffer): Promise<void> {
    const base64 = audioBuffer.toString('base64');
    const existing = this.memoryStore.get(id);
    if (existing) {
      existing.audioBase64 = base64;
    } else {
      this.memoryStore.set(id, {
        _id: id,
        symbol: 'UNKNOWN',
        headline: '',
        summary: '',
        source: '',
        url: '',
        publishedAt: new Date().toISOString(),
        sentiment: 1,
        label: 'BULLISH',
        confidence: 1,
        probabilities: { bullish: 1, bearish: 0 },
        rawChoice: 'bullish',
        createdAt: new Date().toISOString(),
        audioBase64: base64,
        priority: 'ROUTINE_NOISE',
        priorityConfidence: 1,
        isBreaking: false,
        urgencyScore: 0,
      });
    }

    if (this.collection) {
      await traceSpan('mongo.save_audio', 'db.write', { id, bytes: audioBuffer.length }, async () => {
        await this.collection!.updateOne(
          { _id: id },
          { $set: { audioBase64: base64 } },
          { upsert: true }
        );
      });
    }
  }

  /**
   * Retrieves a cached ElevenLabs MP3 audio buffer from MongoDB.
   */
  public async getAudio(id: number): Promise<Buffer | null> {
    const doc = await this.getCachedPrediction(id);
    if (doc?.audioBase64) {
      return Buffer.from(doc.audioBase64, 'base64');
    }
    return null;
  }

  public async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
