import { MongoClient, type Collection, type Db } from 'mongodb';
import type { FinnhubNewsArticle, StockQuote } from '../types/finnhub.js';
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

export interface NewsQueryOptions {
  limit?: number;
  offset?: number;
  symbol?: string;
  symbols?: string[];
  sentiment?: 1 | 0;
  priority?: 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE';
  breakingOnly?: boolean;
  fromDate?: string;
  toDate?: string;
  sortBy?: 'date' | 'impact' | 'confidence';
}

export interface SyncMetadata {
  _id: string; // Ticker symbol, e.g. "AAPL"
  lastSyncedAt: string;
  articlesCount: number;
  // UTC dates (YYYY-MM-DD); absent on legacy timestamp-only records.
  syncedFrom?: string;
  syncedTo?: string;
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

  // Real-time market price metrics
  price?: number;
  change?: number;
  percentChange?: number;
  dayHigh?: number;
  dayLow?: number;
  previousClose?: number;
  priceUpdatedAt?: string;
}

export class PredictionStorageService {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private collection: Collection<StoredArticle> | null = null;
  private syncCollection: Collection<SyncMetadata> | null = null;
  private quoteCollection: Collection<StockQuote & { _id: string }> | null = null;
  private readonly memoryStore = new Map<number, StoredArticle>();
  private readonly syncMemoryStore = new Map<string, SyncMetadata>();
  private readonly quotesMemoryStore = new Map<string, StockQuote>();

  constructor(
    private readonly uri?: string,
    private readonly dbName = 'zero_market_radar'
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
      this.syncCollection = this.db.collection<SyncMetadata>('sync_metadata');
      this.quoteCollection = this.db.collection<StockQuote & { _id: string }>('stock_quotes');

      // Create indexes for efficient querying and aggregation
      await this.collection.createIndex({ symbol: 1, publishedAt: -1 });
      await this.collection.createIndex({ publishedAt: -1 });
      await this.collection.createIndex({ createdAt: -1 });
      await this.collection.createIndex({ sentiment: 1 });
      await this.collection.createIndex({ urgencyScore: -1 });
      await this.collection.createIndex({ priority: 1 });
      await this.quoteCollection.createIndex({ symbol: 1 });

      console.log('✅ [MongoDB] Connected to centralized MongoDB cluster.');
    } catch (err) {
      console.warn('⚠️ [MongoDB] Connection failed. Falling back to internal memory prediction store:', err instanceof Error ? err.message : err);
      this.client = null;
      this.collection = null;
      this.syncCollection = null;
      this.quoteCollection = null;
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
   * Fetches recently stored article IDs to warm up the in-memory deduplication cache on startup.
   */
  public async getRecentArticleIds(limit = 10000): Promise<number[]> {
    return traceSpan('mongo.get_recent_article_ids', 'db.read', { limit }, async () => {
      if (this.collection) {
        const docs = await this.collection
          .find({}, { projection: { _id: 1 } })
          .sort({ publishedAt: -1 })
          .limit(limit)
          .toArray();
        return docs.map((doc) => doc._id);
      }
      return Array.from(this.memoryStore.keys()).slice(0, limit);
    });
  }

  /**
   * Retrieves confirmed query coverage, not inferred dates from individual articles.
   */
  public async getSyncMetadata(symbol: string): Promise<SyncMetadata | null> {
    const sym = symbol.toUpperCase();
    return traceSpan('mongo.get_sync_metadata', 'db.read', { symbol: sym }, async () => {
      if (this.syncCollection) {
        return await this.syncCollection.findOne({ _id: sym });
      }
      const meta = this.syncMemoryStore.get(sym);
      return meta ? { ...meta } : null;
    });
  }

  /**
   * Extends an overlapping, successfully processed query range without shrinking coverage.
   */
  public async setSyncRange(
    symbol: string,
    syncedFrom: string,
    syncedTo: string,
    articlesCount = 0,
    date: Date = new Date()
  ): Promise<void> {
    const sym = symbol.toUpperCase();

    if (this.syncCollection) {
      await traceSpan('mongo.set_sync_range', 'db.write', { symbol: sym }, async () => {
        await this.syncCollection!.updateOne(
          { _id: sym },
          {
            $set: {
              _id: sym,
              lastSyncedAt: date.toISOString(),
              articlesCount,
            },
            $min: { syncedFrom },
            $max: { syncedTo },
          },
          { upsert: true }
        );
      });
    }

    const previous = this.syncMemoryStore.get(sym);
    this.syncMemoryStore.set(sym, {
      _id: sym,
      lastSyncedAt: date.toISOString(),
      articlesCount,
      syncedFrom: previous?.syncedFrom && previous.syncedFrom < syncedFrom ? previous.syncedFrom : syncedFrom,
      syncedTo: previous?.syncedTo && previous.syncedTo > syncedTo ? previous.syncedTo : syncedTo,
    });
  }

  /**
   * Save a real-time stock price quote in MongoDB and memory cache.
   */
  public async saveQuote(quote: StockQuote): Promise<void> {
    const sym = quote.symbol.toUpperCase();
    const price = quote.price ?? quote.current;
    const current = quote.current ?? quote.price ?? 0;
    const normalizedQuote: StockQuote = { ...quote, price, current };
    this.quotesMemoryStore.set(sym, normalizedQuote);

    if (this.quoteCollection) {
      await traceSpan('mongo.save_quote', 'db.write', { symbol: sym }, async () => {
        await this.quoteCollection!.updateOne(
          { _id: sym },
          { $set: { ...normalizedQuote, _id: sym } },
          { upsert: true }
        );
      });
    }
  }

  /**
   * Retrieve cached quote for a single symbol.
   */
  public async getQuote(symbol: string): Promise<StockQuote | null> {
    const sym = symbol.toUpperCase();
    if (this.quoteCollection) {
      try {
        const doc = await this.quoteCollection.findOne({ _id: sym });
        if (doc) return doc;
      } catch {
        // Fall back to memory
      }
    }
    return this.quotesMemoryStore.get(sym) || null;
  }

  /**
   * Retrieve all cached quotes for watchlists.
   */
  public async getAllQuotes(): Promise<Record<string, StockQuote>> {
    const map: Record<string, StockQuote> = {};
    for (const [sym, q] of this.quotesMemoryStore.entries()) {
      map[sym] = q;
    }
    if (this.quoteCollection) {
      try {
        const docs = await this.quoteCollection.find({}).toArray();
        for (const d of docs) {
          map[d.symbol.toUpperCase()] = d;
        }
      } catch {
        // Fall back to memory map
      }
    }
    return map;
  }

  /**
   * Returns a list of symbols that already have historical articles or sync metadata stored in MongoDB,
  * for startup reporting; query coverage is checked independently by the poller.
   */
  public async getSeededSymbols(): Promise<string[]> {
    return traceSpan('mongo.get_seeded_symbols', 'db.read', {}, async () => {
      const set = new Set<string>();

      if (this.syncCollection) {
        const allMeta = await this.syncCollection.find({}, { projection: { _id: 1 } }).toArray();
        for (const m of allMeta) {
          set.add(String(m._id).toUpperCase());
        }
      }

      if (this.collection) {
        const symbols = await this.collection.distinct('symbol');
        for (const s of symbols) {
          set.add(String(s).toUpperCase());
        }
      }

      for (const sym of this.syncMemoryStore.keys()) {
        set.add(sym.toUpperCase());
      }
      for (const art of this.memoryStore.values()) {
        if (art.symbol) set.add(art.symbol.toUpperCase());
      }

      return Array.from(set);
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

    if (this.collection) {
      await traceSpan('mongo.save_prediction', 'db.write', { id: article.id, symbol: article.related }, async () => {
        await this.collection!.updateOne(
          { _id: article.id },
          { $set: doc },
          { upsert: true }
        );
      });
    }
    // Failed Mongo writes must remain retryable, not appear as cached successes.
    this.memoryStore.set(article.id, doc);
  }

  /**
   * Fetches recent news articles ordered by publication date or urgency score.
   */
  public async getRecentNews(
    optionsOrLimit: number | NewsQueryOptions = 50,
    symbol?: string,
    sentiment?: 1 | 0,
    priority?: 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE',
    breakingOnly = false,
    fromDate?: string,
    toDate?: string,
    sortBy: 'date' | 'impact' | 'confidence' = 'date'
  ): Promise<StoredArticle[]> {
    const opts: NewsQueryOptions =
      typeof optionsOrLimit === 'object'
        ? optionsOrLimit
        : {
            limit: optionsOrLimit,
            symbol,
            sentiment,
            priority,
            breakingOnly,
            fromDate,
            toDate,
            sortBy,
          };

    const limit = opts.limit ?? 50;
    // ponytail: offset pagination scans skipped rows and live inserts can shift pages;
    // use compound sort-key cursors if history size or snapshot consistency requires it.
    const offset = opts.offset ?? 0;
    const sortMode = opts.sortBy ?? 'date';

    if (this.collection) {
      const query: Record<string, unknown> = {};

      if (opts.symbols && opts.symbols.length > 0) {
        const upperSymbols = opts.symbols.map((s) => s.toUpperCase());
        query['symbol'] = upperSymbols.length === 1 ? upperSymbols[0] : { $in: upperSymbols };
      } else if (opts.symbol) {
        query['symbol'] = opts.symbol.toUpperCase();
      }

      if (opts.sentiment !== undefined) query['sentiment'] = opts.sentiment;
      if (opts.priority) query['priority'] = opts.priority;
      if (opts.breakingOnly) query['isBreaking'] = true;

      if (opts.fromDate || opts.toDate) {
        const dateRange: Record<string, string> = {};
        if (opts.fromDate) {
          dateRange['$gte'] = opts.fromDate.includes('T') ? opts.fromDate : `${opts.fromDate}T00:00:00.000Z`;
        }
        if (opts.toDate) {
          dateRange['$lte'] = opts.toDate.includes('T') ? opts.toDate : `${opts.toDate}T23:59:59.999Z`;
        }
        query['publishedAt'] = dateRange;
      }

      const sortQuery: Record<string, 1 | -1> =
        sortMode === 'impact'
          ? { urgencyScore: -1, confidence: -1, publishedAt: -1, _id: -1 }
          : sortMode === 'confidence'
            ? { confidence: -1, publishedAt: -1, _id: -1 }
            : { publishedAt: -1, createdAt: -1, _id: -1 };

      return await this.collection
        .find(query)
        .sort(sortQuery)
        .skip(offset)
        .limit(limit)
        .toArray();
    }

    // Fallback: query memory store
    let items = Array.from(this.memoryStore.values());

    if (opts.symbols && opts.symbols.length > 0) {
      const symSet = new Set(opts.symbols.map((s) => s.toUpperCase()));
      items = items.filter((item) => symSet.has(item.symbol.toUpperCase()));
    } else if (opts.symbol) {
      items = items.filter((item) => item.symbol.toUpperCase() === opts.symbol!.toUpperCase());
    }

    if (opts.sentiment !== undefined) {
      items = items.filter((item) => item.sentiment === opts.sentiment);
    }
    if (opts.priority) {
      items = items.filter((item) => item.priority === opts.priority);
    }
    if (opts.breakingOnly) {
      items = items.filter((item) => item.isBreaking);
    }

    if (opts.fromDate) {
      const fromTime = new Date(opts.fromDate.includes('T') ? opts.fromDate : `${opts.fromDate}T00:00:00.000Z`).getTime();
      items = items.filter((item) => new Date(item.publishedAt).getTime() >= fromTime);
    }
    if (opts.toDate) {
      const toTime = new Date(opts.toDate.includes('T') ? opts.toDate : `${opts.toDate}T23:59:59.999Z`).getTime();
      items = items.filter((item) => new Date(item.publishedAt).getTime() <= toTime);
    }

    if (sortMode === 'impact') {
      items.sort((a, b) => {
        const scoreA = a.urgencyScore ?? (a.priority === 'BREAKING_CRITICAL' ? 0.95 : a.priority === 'NOTABLE_CATALYST' ? 0.6 : 0.1);
        const scoreB = b.urgencyScore ?? (b.priority === 'BREAKING_CRITICAL' ? 0.95 : b.priority === 'NOTABLE_CATALYST' ? 0.6 : 0.1);
        if (scoreB !== scoreA) return scoreB - scoreA;
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() || b._id - a._id;
      });
    } else if (sortMode === 'confidence') {
      items.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime() || b._id - a._id;
      });
    } else {
      items.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
        || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || b._id - a._id);
    }

    return items.slice(offset, offset + limit);
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

    const hasTargetFilter = Array.isArray(watchlist) && watchlist.length > 0;
    const allowedSet = hasTargetFilter
      ? new Set(watchlist.map((s) => s.toUpperCase()))
      : null;

    // Initialize with watchlist tickers
    for (const sym of watchlist) {
      map.set(sym.toUpperCase(), {
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
      if (allowedSet && !allowedSet.has(sym)) {
        continue;
      }
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

    const quotes = await this.getAllQuotes();
    const result: StockAggregate[] = [];
    for (const [symbol, stats] of map.entries()) {
      const bullishRatio = stats.total > 0 ? stats.bullish / stats.total : 0.5;
      const avgConfidence = stats.total > 0 ? stats.confidenceSum / stats.total : 0;
      const q = quotes[symbol];

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
        price: q ? (q.price ?? q.current) : undefined,
        change: q?.change,
        percentChange: q?.percentChange,
        dayHigh: q?.high,
        dayLow: q?.low,
        previousClose: q?.previousClose,
        priceUpdatedAt: q?.timestamp ? String(q?.timestamp) : undefined,
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
