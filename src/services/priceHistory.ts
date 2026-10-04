import type { FinnhubClient } from './finnhub.js';
import type { PredictionStorageService } from './mongodb.js';
import { validatePriceCandles } from './mongodb.js';
import type { PricePoint } from '../types/finnhub.js';
import { PRICE_HISTORY_INTERVALS } from '../types/finnhub.js';

export interface PriceHistoryResult {
  candles: PricePoint[];
  stale: boolean;
  fetchedAt: number | null;
}

export class PriceHistoryService {
  private readonly cache = new Map<string, { result: PriceHistoryResult; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<PriceHistoryResult>>();

  constructor(private readonly storage: PredictionStorageService, private readonly client: Pick<FinnhubClient, 'fetchPriceHistory'>) {}

  public async get(symbol: string, range = '7d'): Promise<PriceHistoryResult> {
    const sym = symbol.toUpperCase();
    if (!/^[A-Z0-9.^=-]{1,20}$/.test(sym) || !Object.hasOwn(PRICE_HISTORY_INTERVALS, range)) {
      throw new TypeError('Invalid price history symbol or range');
    }
    const key = `${sym}:${range}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.result;
    }
    const pending = this.pending.get(key);
    if (pending !== undefined) return pending;
    const request = this.load(sym, range, cached?.result).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  private async load(symbol: string, range: string, previous?: PriceHistoryResult): Promise<PriceHistoryResult> {
    const key = `${symbol}:${range}`;
    const ttl = range === 'max' ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
    const interval = PRICE_HISTORY_INTERVALS[range as keyof typeof PRICE_HISTORY_INTERVALS];
    let result: PriceHistoryResult = { candles: previous?.candles ?? [], fetchedAt: previous?.fetchedAt ?? null, stale: true };
    let refresh = true;
    let expiresAt: number | null = null;
    try {
      const metadata = await this.storage.getPriceHistoryMetadata(symbol, range);
      if (metadata) {
        const candles = await this.storage.getPriceCandles(symbol, interval, metadata.from, metadata.to);
        if (candles.length) {
          result = { candles, fetchedAt: metadata.fetchedAt, stale: Date.now() - metadata.fetchedAt >= ttl };
          refresh = result.stale;
          if (!refresh) expiresAt = metadata.fetchedAt + ttl;
        }
      }
    } catch (err) {
      console.warn(`[PriceHistory] Failed to read ${key}:`, err);
    }
    if (refresh) {
      try {
        // ponytail: daily 'max' refresh re-upserts all available daily bars, catching
        // downtime and provider adjustments. At scale use incremental sync + periodic full reconciliation.
        const candles = await this.client.fetchPriceHistory(symbol, range);
        if (!candles.length) throw new Error('Provider returned no candles');
        validatePriceCandles(candles);
        const fetchedAt = Date.now();
        result = { candles: [...new Map(candles.map(c => [c.timestamp, c])).values()].sort((a, b) => a.timestamp - b.timestamp), fetchedAt, stale: false };
        await this.storage.savePriceCandles(symbol, interval, candles, fetchedAt);
        await this.storage.savePriceHistoryMetadata({
          _id: key, symbol, range, interval, fetchedAt,
          from: result.candles[0]!.timestamp, to: result.candles.at(-1)!.timestamp,
        });
        expiresAt = fetchedAt + ttl;
      } catch (err) {
        console.warn(`[PriceHistory] Failed to refresh ${key}:`, err);
      }
    }
    // Failed/empty refreshes retry after one minute rather than on every poll or page view.
    this.cache.delete(key);
    this.cache.set(key, { result, expiresAt: expiresAt ?? Date.now() + 60000 });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
}