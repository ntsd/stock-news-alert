import type { FinnhubNewsArticle } from '../types/finnhub.js';
import type { FinnhubClient } from '../services/finnhub.js';
import type { JevClassificationService } from '../services/jev.js';
import type { TelegramAlertService } from '../services/telegram.js';
import type { BoundedTtlLruCache } from '../cache/lru.js';
import { formatNewsAlertHtml } from '../utils/telegramFormat.js';

export interface PollerOptions {
  watchlist: string[];
  pollIntervalMs: number;
  minConfidence: number;
  finnhubClient: FinnhubClient;
  jevService: JevClassificationService;
  telegramService: TelegramAlertService;
  deduplicator: BoundedTtlLruCache;
}

export interface PollerStats {
  isRunning: boolean;
  totalPolls: number;
  articlesSeen: number;
  alertsSent: number;
  lastPollTime: string | null;
  currentSymbol: string | null;
  watchlistSize: number;
  cacheSize: number;
  seededSymbols: string[];
}

export class NewsAlertPoller {
  private readonly watchlist: string[];
  private readonly pollIntervalMs: number;
  private readonly minConfidence: number;
  private readonly finnhubClient: FinnhubClient;
  private readonly jevService: JevClassificationService;
  private readonly telegramService: TelegramAlertService;
  private readonly deduplicator: BoundedTtlLruCache;

  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private symbolIndex = 0;
  private nextScheduledTime = 0;

  // Track symbols that have completed cold-start baseline seeding
  private readonly seededSymbols = new Set<string>();

  // Operational metrics
  private totalPolls = 0;
  private articlesSeen = 0;
  private alertsSent = 0;
  private lastPollTime: string | null = null;
  private currentSymbol: string | null = null;

  constructor(options: PollerOptions) {
    this.watchlist = [...options.watchlist];
    this.pollIntervalMs = options.pollIntervalMs;
    this.minConfidence = options.minConfidence;
    this.finnhubClient = options.finnhubClient;
    this.jevService = options.jevService;
    this.telegramService = options.telegramService;
    this.deduplicator = options.deduplicator;
  }

  /**
   * Starts the drift-compensated round-robin polling loop.
   */
  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.nextScheduledTime = Date.now();

    console.log(
      `🚀 [Poller] Started polling scheduler across ${this.watchlist.length} symbols: [${this.watchlist.join(', ')}]`
    );
    console.log(
      `⏱ [Poller] Pace: 1 request every ${this.pollIntervalMs}ms (~${Math.round(60000 / this.pollIntervalMs)} req/min, free tier cap: 60/min)`
    );

    this.scheduleNextTick();
  }

  /**
   * Graceful stop of the polling loop.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('🛑 [Poller] Polling scheduler stopped.');
  }

  public getStats(): PollerStats {
    return {
      isRunning: this.isRunning,
      totalPolls: this.totalPolls,
      articlesSeen: this.articlesSeen,
      alertsSent: this.alertsSent,
      lastPollTime: this.lastPollTime,
      currentSymbol: this.currentSymbol,
      watchlistSize: this.watchlist.length,
      cacheSize: this.deduplicator.size,
      seededSymbols: Array.from(this.seededSymbols),
    };
  }

  private scheduleNextTick(): void {
    if (!this.isRunning) return;

    this.nextScheduledTime += this.pollIntervalMs;
    const now = Date.now();
    const delay = Math.max(0, this.nextScheduledTime - now);

    this.timer = setTimeout(async () => {
      await this.tick();
      this.scheduleNextTick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.isRunning || this.watchlist.length === 0) return;

    const symbol = this.watchlist[this.symbolIndex]!;
    this.symbolIndex = (this.symbolIndex + 1) % this.watchlist.length;
    this.currentSymbol = symbol;
    this.totalPolls++;
    this.lastPollTime = new Date().toISOString();

    try {
      const articles = await this.finnhubClient.fetchCompanyNews(symbol);
      await this.processArticlesForSymbol(symbol, articles);
    } catch (error) {
      console.error(`❌ [Poller] Error polling news for ${symbol}:`, error instanceof Error ? error.message : error);
    }
  }

  private async processArticlesForSymbol(
    symbol: string,
    articles: FinnhubNewsArticle[]
  ): Promise<void> {
    const isFirstRun = !this.seededSymbols.has(symbol);

    if (isFirstRun) {
      // Cold-start seed: Populate deduplication cache with existing articles
      // to avoid blasting Telegram with stale news on boot.
      for (const article of articles) {
        this.deduplicator.add(article.id);
      }
      this.seededSymbols.add(symbol);
      console.log(
        `🌱 [Poller] Seeded cold-start baseline for ${symbol}: ${articles.length} historical articles cached.`
      );
      return;
    }

    // Process new articles in chronological order (oldest to newest)
    const sortedArticles = [...articles].sort((a, b) => a.datetime - b.datetime);

    for (const article of sortedArticles) {
      if (this.deduplicator.has(article.id)) {
        continue;
      }

      // Mark article as seen immediately to prevent race conditions
      this.deduplicator.add(article.id);
      this.articlesSeen++;

      console.log(
        `✨ [Poller] New article detected for ${symbol} (#${article.id}): "${article.headline.substring(0, 60)}..."`
      );

      try {
        // System 1 Decision Model classification with Jev
        const classification = await this.jevService.classifyArticleSentiment(article);

        console.log(
          `🧠 [Jev] Decision for #${article.id}: ${classification.label} (${classification.sentiment}) | Conf: ${(classification.confidence * 100).toFixed(1)}%`
        );

        // Confidence cutoff check
        if (classification.confidence < this.minConfidence) {
          console.log(
            `⚠️ [Poller] Skipping alert for #${article.id}: Confidence ${(classification.confidence * 100).toFixed(1)}% < ${this.minConfidence * 100}% threshold`
          );
          continue;
        }

        // Format and dispatch Telegram notification
        const alertHtml = formatNewsAlertHtml(article, classification);
        await this.telegramService.sendAlert(alertHtml);

        this.alertsSent++;
        console.log(`📨 [Telegram] Alert delivered for ${symbol} (#${article.id})`);
      } catch (err) {
        console.error(
          `❌ [Poller] Error evaluating/alerting article #${article.id} for ${symbol}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
}
