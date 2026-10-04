import type { FinnhubNewsArticle } from '../types/finnhub.js';
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
}
