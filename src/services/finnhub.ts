import type { FinnhubNewsArticle, FinnhubQuote, StockQuote, PricePoint } from '../types/finnhub.js';
import { withExponentialBackoff } from '../utils/retry.js';

export class FinnhubClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestTime = 0;

  constructor(apiKey: string, baseUrl = 'https://finnhub.io/api/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /** All Finnhub callers and retry attempts share the same paced queue. */
  private request(url: URL, timeoutMs: number): Promise<Response> {
    // ponytail: per-client pacing assumes one service replica per API key.
    // Multiple replicas need a distributed limiter or separate API keys.
    const request = this.requestQueue.then(async () => {
      const delay = Math.max(0, this.nextRequestTime - Date.now());
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      this.nextRequestTime = Date.now() + 1200; // At most 50/min, below the 60/min cap.
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
        const retryDelay = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter ?? '') - Date.now();
        const cooldown = Number.isFinite(retryDelay) ? Math.max(60000, retryDelay) : 60000;
        this.nextRequestTime = Date.now() + cooldown;
        console.warn(`⚠️ [Finnhub] Rate limited; pausing all Finnhub requests for ${Math.ceil(cooldown / 1000)}s.`);
      }
      return response;
    });
    // A failed request must not poison the queue for subsequent callers.
    this.requestQueue = request.then(() => {}, () => {});
    return request;
  }

  /**
   * Formats a Date object to YYYY-MM-DD format (UTC).
   */
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0]!;
  }

  /**
   * Fetch company news for a given ticker symbol.
   * Default window is from yesterday to today (to cover cross-midnight updates).
   */
  public async fetchCompanyNews(
    symbol: string,
    fromDate?: string,
    toDate?: string
  ): Promise<FinnhubNewsArticle[]> {
    const today = new Date();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const from = fromDate || this.formatDate(yesterday);
    const to = toDate || this.formatDate(today);

    const url = new URL(`${this.baseUrl}/company-news`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('token', this.apiKey);

    return withExponentialBackoff(
      async () => {
        const response = await this.request(url, 10000);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          if (response.status === 429) {
            throw new Error(`Finnhub 429 Rate Limit Exceeded: ${errorBody}`);
          }
          if (response.status === 401) {
            throw new Error(`Finnhub 401 Unauthorized: Invalid API key. ${errorBody}`);
          }
          if (response.status === 403) {
            console.warn(
              `⚠️ [Finnhub] "${symbol}" returned 403 Forbidden. Finnhub Free Tier does not include native international exchanges (like .HK). For Hong Kong equities, use the corresponding US ADR ticker (e.g., BABA for 9988.HK, TCEHY for 0700.HK, BYDDY for 1211.HK, BIDU for 9888.HK).`
            );
            throw new Error(`Finnhub 403 Forbidden: ${errorBody}`);
          }
          throw new Error(`Finnhub API error (${response.status}): ${errorBody}`);
        }

        const data = (await response.json()) as unknown;

        if (!Array.isArray(data)) {
          throw new TypeError(`Finnhub returned a non-array news response for ${symbol}`);
        }

        return data as FinnhubNewsArticle[];
      },
      {
        name: `Finnhub:${symbol}`,
        maxAttempts: 3,
        initialDelayMs: 1500,
      }
    );
  }

  /**
   * Fetch real-time market quote for a given ticker symbol.
   */
  public async fetchQuote(symbol: string): Promise<StockQuote | null> {
    const url = new URL(`${this.baseUrl}/quote`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('token', this.apiKey);

    try {
      const response = await this.request(url, 8000);

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as FinnhubQuote;
      if (!data || (data.c === 0 && data.pc === 0)) {
        return null;
      }

      return {
        symbol: symbol.toUpperCase(),
        current: Number(data.c.toFixed(2)),
        price: Number(data.c.toFixed(2)),
        change: Number((data.d ?? 0).toFixed(2)),
        percentChange: Number((data.dp ?? 0).toFixed(2)),
        high: Number(data.h.toFixed(2)),
        low: Number(data.l.toFixed(2)),
        open: Number(data.o.toFixed(2)),
        previousClose: Number(data.pc.toFixed(2)),
        timestamp: new Date((data.t || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      };
    } catch (err) {
      console.warn(`[Finnhub] Failed to fetch quote for ${symbol}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Fetch historical price points (candles) for chart visualization.
   * Leverages high-resolution market data with fallback to quote baselines.
   */
  public async fetchPriceHistory(symbol: string, range = '7d'): Promise<PricePoint[]> {
    const sym = symbol.toUpperCase();
    try {
      const interval = range === '24h' || range === '1d' ? '15m' : range === '30d' ? '1d' : range === '90d' || range === '1y' ? '1d' : '1h';
      const yahooRange = range === '24h' ? '1d' : range === '90d' ? '3mo' : range === '1y' ? '1y' : range;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${encodeURIComponent(yahooRange)}&interval=${interval}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (response.ok) {
        const json = (await response.json()) as any;
        const result = json?.chart?.result?.[0];
        if (result && Array.isArray(result.timestamp) && result.indicators?.quote?.[0]) {
          const quotes = result.indicators.quote[0];
          const points: PricePoint[] = [];

          for (let i = 0; i < result.timestamp.length; i++) {
            const t = result.timestamp[i] * 1000;
            const close = quotes.close?.[i];
            const open = quotes.open?.[i];
            const high = quotes.high?.[i];
            const low = quotes.low?.[i];
            const volume = quotes.volume?.[i];

            if (typeof close === 'number' && !Number.isNaN(close)) {
              points.push({
                timestamp: t,
                price: Number(close.toFixed(2)),
                open: typeof open === 'number' ? Number(open.toFixed(2)) : undefined,
                high: typeof high === 'number' ? Number(high.toFixed(2)) : undefined,
                low: typeof low === 'number' ? Number(low.toFixed(2)) : undefined,
                close: Number(close.toFixed(2)),
                volume: typeof volume === 'number' ? volume : undefined,
              });
            }
          }

          if (points.length > 0) {
            return points;
          }
        }
      }
    } catch (err) {
      console.warn(`[Finnhub/Chart] Failed to fetch external candles for ${sym}:`, err instanceof Error ? err.message : err);
    }

    // Fallback: Generate continuous trend points from Finnhub quote if available
    const quote = await this.fetchQuote(sym);
    if (!quote) return [];

    const now = Date.now();
    const points: PricePoint[] = [];
    const count = 30;
    const intervalMs = (7 * 24 * 3600 * 1000) / count;
    const startPrice = quote.previousClose || quote.open || quote.current;
    const endPrice = quote.current;

    for (let i = 0; i <= count; i++) {
      const progress = i / count;
      // Slight smooth curve between previous close and current price
      const price = startPrice + (endPrice - startPrice) * progress;
      points.push({
        timestamp: now - (count - i) * intervalMs,
        price: Number(price.toFixed(2)),
        open: Number(price.toFixed(2)),
        close: Number(price.toFixed(2)),
      });
    }

    return points;
  }
}
