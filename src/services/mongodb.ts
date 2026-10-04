import { MongoClient, type Collection, type Db } from 'mongodb';
import type { FinnhubNewsArticle, StockQuote, PricePoint, PriceInterval } from '../types/finnhub.js';
export type { PriceInterval } from '../types/finnhub.js';
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
  evaluatedBy?: 'jev'; // Absent on legacy records that may contain baseline placeholders.
  audioBase64?: string; // Cached ElevenLabs MP3

  // Unified Priority & Urgency
  priority: 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE';
  priorityConfidence: number;
  isBreaking: boolean;
  urgencyScore: number;
}

export interface NewsQueryOptions {
  // Internal queries may use 0 for all matches; public feed pagination stays bounded.
  limit?: number;
  offset?: number;
  symbol?: string;
  symbols?: string[];
  sentiment?: 1 | 0;
  priority?: 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE';
  breakingOnly?: boolean;
  unevaluatedOnly?: boolean;
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
  evaluatedAll?: boolean; // All articles in the latest sync window received genuine inference.
}

export interface PriceHistoryMetadata {
  _id: string;
  symbol: string;
  range: string;
  interval: PriceInterval;
  fetchedAt: number;
  from: number;
  to: number;
}
export interface StoredPriceCandle extends PricePoint {
  _id: string;
  symbol: string;
  interval: PriceInterval;
  provider: 'yahoo';
  fetchedAt: number;
}

export function validatePriceCandles(candles: PricePoint[]): void {
  if (candles.some(c => !Number.isSafeInteger(c.timestamp) || c.timestamp <= 0
    || !Number.isFinite(c.price) || c.price <= 0
    || [c.open, c.high, c.low, c.close, c.volume, c.adjustedClose].some(v => v !== undefined && !Number.isFinite(v)))) {
    throw new TypeError('Invalid price candle');
  }
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
  private priceCollection: Collection<StoredPriceCandle> | null = null;
  private priceMetadataCollection: Collection<PriceHistoryMetadata> | null = null;
  private readonly priceMemoryStore = new Map<string, StoredPriceCandle[]>();
  private readonly priceMetadataMemoryStore = new Map<string, PriceHistoryMetadata>();
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
        connectTimeoutMS: 10000,
        serverSelectionTimeoutMS: 30000,
      });
      await this.client.connect();
      this.db = this.client.db(this.dbName);
      this.collection = this.db.collection<StoredArticle>('predictions');
      this.syncCollection = this.db.collection<SyncMetadata>('sync_metadata');
      this.quoteCollection = this.db.collection<StockQuote & { _id: string }>('stock_quotes');
      this.priceCollection = this.db.collection<StoredPriceCandle>('price_candles');
      this.priceMetadataCollection = this.db.collection<PriceHistoryMetadata>('price_history_metadata');

      // Create indexes for efficient querying and aggregation
      await this.collection.createIndex({ symbol: 1, publishedAt: -1 });
      await this.collection.createIndex({ publishedAt: -1 });
      await this.collection.createIndex({ createdAt: -1 });
      await this.collection.createIndex({ sentiment: 1 });
      await this.collection.createIndex({ urgencyScore: -1 });
      await this.collection.createIndex({ priority: 1 });
      await this.collection.createIndex({ symbol: 1, publishedAt: -1, createdAt: -1, _id: -1 });
      await this.collection.createIndex({ publishedAt: -1, createdAt: -1, _id: -1 });
      await this.collection.createIndex({ urgencyScore: -1, confidence: -1, publishedAt: -1, _id: -1 });
      await this.collection.createIndex({ confidence: -1, publishedAt: -1, _id: -1 });
      await this.collection.createIndex({ evaluatedBy: 1, symbol: 1, publishedAt: -1 });
      await this.quoteCollection.createIndex({ symbol: 1 });
      await this.priceCollection.createIndex(
        { symbol: 1, interval: 1, timestamp: 1 }, { unique: true }
      );

      console.log('✅ [MongoDB] Connected to centralized MongoDB cluster.');
    } catch (err) {
      await this.client?.close();
      this.client = null;
      this.db = null;
      this.collection = null;
      this.syncCollection = null;
      this.quoteCollection = null;
      this.priceCollection = null;
      this.priceMetadataCollection = null;
      throw new Error('MongoDB initialization failed; refusing to start with in-memory storage when MONGODB_URI is configured.', { cause: err });
    }
  }

  /**
   * Check if a prediction is already cached in centralized storage.
   */
  public async getCachedPrediction(id: number): Promise<StoredArticle | null> {
    return traceSpan('mongo.get_cached_prediction', 'db.cache', { id }, async () => {
      if (this.collection) {
        return await this.collection.findOne({ _id: id }, { projection: { audioBase64: 0 } });
      }
      return this.memoryStore.get(id) || null;
    });
  }

  /**
   * Fetches recently stored article IDs to warm up the in-memory deduplication cache on startup.
   */
  public async getRecentArticleIds(limit = 10000, watchlist?: string[]): Promise<number[]> {
    const symbols = watchlist?.map(symbol => symbol.toUpperCase());
    return traceSpan('mongo.get_recent_article_ids', 'db.read', { limit }, async () => {
      if (this.collection) {
        const docs = await this.collection
          .find({ evaluatedBy: 'jev', ...(symbols ? { symbol: { $in: symbols } } : {}) }, { projection: { _id: 1 } })
          .sort({ publishedAt: -1 })
          .limit(limit)
          .toArray();
        return docs.map((doc) => doc._id);
      }
      return Array.from(this.memoryStore.values()).filter(doc => doc.evaluatedBy === 'jev'
        && (!symbols || symbols.includes(doc.symbol.toUpperCase()))).slice(0, limit).map(doc => doc._id);
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
    date: Date = new Date(),
    evaluatedAll = false
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
              ...(evaluatedAll ? { evaluatedAll: true } : {}),
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
      ...(evaluatedAll || previous?.evaluatedAll ? { evaluatedAll: true } : {}),
    });
  }

  /** Upsert genuine candles without deleting older history. */
  public async savePriceCandles(symbol: string, interval: PriceInterval, candles: PricePoint[], fetchedAt = Date.now()): Promise<void> {
    const sym = symbol.toUpperCase();
    validatePriceCandles(candles);
    const docs = [...new Map(candles.map(c => [c.timestamp, {
      ...c, _id: `${sym}:${interval}:${c.timestamp}`, symbol: sym, interval,
      provider: 'yahoo' as const, fetchedAt,
    }])).values()];
    if (docs.length === 0) return;
    if (this.priceCollection) {
      await this.priceCollection.bulkWrite(docs.map(doc => ({ updateOne: {
        filter: { _id: doc._id }, update: { $set: doc }, upsert: true,
      } })), { ordered: false });
      return;
    }
    const key = `${sym}:${interval}`;
    const merged = new Map((this.priceMemoryStore.get(key) ?? []).map(c => [c.timestamp, c]));
    for (const doc of docs) merged.set(doc.timestamp, doc);
    // ponytail: memory-only mode is not an archive: keep 100 series / 20k bars each.
    // Configure MongoDB for durable, uncapped history.
    this.priceMemoryStore.delete(key);
    this.priceMemoryStore.set(key, [...merged.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-20000));
    if (this.priceMemoryStore.size > 100) this.priceMemoryStore.delete(this.priceMemoryStore.keys().next().value!);
  }

  public async getPriceCandles(symbol: string, interval: PriceInterval, from = 0, to = Date.now()): Promise<PricePoint[]> {
    const sym = symbol.toUpperCase();
    const docs = this.priceCollection
      ? await this.priceCollection.find({ symbol: sym, interval, timestamp: { $gte: from, $lte: to } }, {
        projection: { _id: 0, symbol: 0, interval: 0, provider: 0, fetchedAt: 0 },
      }).sort({ timestamp: 1 }).toArray()
      : (this.priceMemoryStore.get(`${sym}:${interval}`) ?? []).filter(c => c.timestamp >= from && c.timestamp <= to);
    return docs.map(({ _id, symbol: storedSymbol, interval: storedInterval, provider, fetchedAt, ...c }) => c);
  }

  public async getPriceHistoryMetadata(symbol: string, range: string): Promise<PriceHistoryMetadata | null> {
    const key = `${symbol.toUpperCase()}:${range}`;
    return this.priceMetadataCollection
      ? this.priceMetadataCollection.findOne({ _id: key })
      : this.priceMetadataMemoryStore.get(key) ?? null;
  }

  public async savePriceHistoryMetadata(metadata: PriceHistoryMetadata): Promise<void> {
    if (this.priceMetadataCollection) {
      await this.priceMetadataCollection.updateOne({ _id: metadata._id }, { $set: metadata }, { upsert: true });
      return;
    }
    this.priceMetadataMemoryStore.delete(metadata._id);
    this.priceMetadataMemoryStore.set(metadata._id, metadata);
    if (this.priceMetadataMemoryStore.size > 100) this.priceMetadataMemoryStore.delete(this.priceMetadataMemoryStore.keys().next().value!);
  }

  /** Save a real-time quote in MongoDB and memory. */
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
  public async getAllQuotes(watchlist?: string[]): Promise<Record<string, StockQuote>> {
    const symbols = watchlist?.map(s => s.toUpperCase());
    const map: Record<string, StockQuote> = {};
    for (const [sym, q] of this.quotesMemoryStore.entries()) {
      if (!symbols || symbols.includes(sym)) map[sym] = q;
    }
    if (this.quoteCollection) {
      try {
        const docs = await this.quoteCollection.find(symbols ? { _id: { $in: symbols } } : {}).toArray();
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
  public async getSeededSymbols(watchlist?: string[]): Promise<string[]> {
    const symbols = watchlist?.map(symbol => symbol.toUpperCase());
    return traceSpan('mongo.get_seeded_symbols', 'db.read', {}, async () => {
      const set = new Set<string>();

      if (this.syncCollection) {
        const allMeta = await this.syncCollection.find(symbols ? { _id: { $in: symbols } } : {}, { projection: { _id: 1 } }).toArray();
        for (const m of allMeta) {
          set.add(String(m._id).toUpperCase());
        }
      }

      if (this.collection) {
        const storedSymbols = await this.collection.distinct('symbol', symbols ? { symbol: { $in: symbols } } : {});
        for (const s of storedSymbols) {
          set.add(String(s).toUpperCase());
        }
      }

      for (const sym of this.syncMemoryStore.keys()) {
        set.add(sym.toUpperCase());
      }
      for (const art of this.memoryStore.values()) {
        if (art.symbol) set.add(art.symbol.toUpperCase());
      }

      return Array.from(set).filter(symbol => !symbols || symbols.includes(symbol));
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
      evaluatedBy: 'jev',
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
      if (opts.unevaluatedOnly) query['evaluatedBy'] = { $ne: 'jev' };

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
        .find(query, { projection: { audioBase64: 0 } })
        .sort(sortQuery)
        .skip(offset)
        .limit(limit)
        .toArray();
    }

    // Fallback: query memory store
    let items = Array.from(this.memoryStore.values());
    if (opts.unevaluatedOnly) items = items.filter(item => item.evaluatedBy !== 'jev');

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

    return (limit === 0 ? items.slice(offset) : items.slice(offset, offset + limit))
      .map(({ audioBase64, ...article }) => article);
  }

  /**
   * Aggregates and ranks watched stocks by bullish ratio and news volume.
   */
  public async getTopStocks(watchlist: string[]): Promise<StockAggregate[]> {
    const allArticles = this.collection ? [] : Array.from(this.memoryStore.values());

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
        lastUpdated: '',
      });
    }

    if (this.collection) {
      const stats = await this.collection.aggregate<{
        _id: string; total: number; bullish: number; bearish: number; confidenceSum: number;
        lastSignal: 1 | 0; lastLabel: 'BULLISH' | 'BEARISH'; lastHeadline: string; lastUpdated: string;
      }>([
        { $match: watchlist.length ? { symbol: { $in: [...allowedSet!] } } : {} },
        { $sort: { publishedAt: -1, _id: -1 } },
        { $group: {
          _id: '$symbol', total: { $sum: 1 },
          bullish: { $sum: { $cond: [{ $eq: ['$sentiment', 1] }, 1, 0] } },
          bearish: { $sum: { $cond: [{ $eq: ['$sentiment', 1] }, 0, 1] } },
          confidenceSum: { $sum: '$confidence' },
          lastSignal: { $first: '$sentiment' }, lastLabel: { $first: '$label' },
          lastHeadline: { $first: '$headline' }, lastUpdated: { $first: '$publishedAt' },
        } },
      ]).toArray();
      for (const { _id, ...entry } of stats) map.set(_id.toUpperCase(), entry);
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

      if (!entry.lastUpdated || art.publishedAt > entry.lastUpdated) {
        entry.lastSignal = art.sentiment;
        entry.lastLabel = art.label;
        entry.lastHeadline = art.headline;
        entry.lastUpdated = art.publishedAt;
      }
    }

    const quotes = await this.getAllQuotes([...map.keys()]);
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
    const doc = this.collection
      ? await this.collection.findOne({ _id: id }, { projection: { audioBase64: 1 } })
      : this.memoryStore.get(id);
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
