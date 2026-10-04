import type { FinnhubNewsArticle, FinnhubQuote, StockQuote, PricePoint } from '../types/finnhub.js';
import { withExponentialBackoff } from '../utils/retry.js';

export class FinnhubClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://finnhub.io/api/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
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
        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
          signal: AbortSignal.timeout(10000), // 10s request timeout
        });

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
            return [];
          }
          throw new Error(`Finnhub API error (${response.status}): ${errorBody}`);
        }

        const data = (await response.json()) as unknown;

        if (!Array.isArray(data)) {
          console.warn(`[Finnhub] Unexpected non-array response for ${symbol}:`, data);
          return [];
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
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });

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
