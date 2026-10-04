import type { FinnhubNewsArticle } from '../types/finnhub.js';
import type { FinnhubClient } from '../services/finnhub.js';
import type { JevClassificationService } from '../services/jev.js';
import type { JevSentimentResult } from '../types/jev.js';
import type { TelegramAlertService } from '../services/telegram.js';
import type { BoundedTtlLruCache } from '../cache/lru.js';
import type { PredictionStorageService } from '../services/mongodb.js';
import type { ElevenLabsService } from '../services/elevenlabs.js';
import { formatNewsAlertHtml } from '../utils/telegramFormat.js';
import { traceSpan } from '../instrumentation/sentry.js';

export interface PollerOptions {
  watchlist: string[];
  pollIntervalMs: number;
  minConfidence: number;
  enableVoiceAlerts: boolean;
  finnhubClient: FinnhubClient;
  jevService: JevClassificationService;
  telegramService: TelegramAlertService;
  storage: PredictionStorageService;
  elevenlabsService: ElevenLabsService;
  deduplicator: BoundedTtlLruCache;
  initialSeededSymbols?: string[];
  historySyncDays?: number;
}

export interface PollerStats {
  isRunning: boolean;
  totalPolls: number;
  articlesSeen: number;
  alertsSent: number;
  voiceAlertsSent: number;
  cacheHits: number;
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
  private readonly enableVoiceAlerts: boolean;
  private readonly finnhubClient: FinnhubClient;
  private readonly jevService: JevClassificationService;
  private readonly telegramService: TelegramAlertService;
  private readonly storage: PredictionStorageService;
  private readonly elevenlabsService: ElevenLabsService;
  private readonly deduplicator: BoundedTtlLruCache;
  private readonly historySyncDays: number;

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
  private voiceAlertsSent = 0;
  private cacheHits = 0;
  private lastPollTime: string | null = null;
  private currentSymbol: string | null = null;

  constructor(options: PollerOptions) {
    this.watchlist = [...options.watchlist];
    this.pollIntervalMs = options.pollIntervalMs;
    this.minConfidence = options.minConfidence;
    this.enableVoiceAlerts = options.enableVoiceAlerts;
    this.finnhubClient = options.finnhubClient;
    this.jevService = options.jevService;
    this.telegramService = options.telegramService;
    this.storage = options.storage;
    this.elevenlabsService = options.elevenlabsService;
    this.deduplicator = options.deduplicator;
    this.historySyncDays = options.historySyncDays ?? 365;

    if (options.initialSeededSymbols) {
      for (const s of options.initialSeededSymbols) {
        this.seededSymbols.add(s.toUpperCase());
      }
    }
  }

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
      voiceAlertsSent: this.voiceAlertsSent,
      cacheHits: this.cacheHits,
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

    await traceSpan('poller.tick', 'scheduler.poll', { symbol }, async () => {
      try {
        const lastSyncDate = await this.storage.getLastSyncDate(symbol);
        const isFirstRun = lastSyncDate === null && !this.seededSymbols.has(symbol);

        const now = new Date();
        const toDate = now.toISOString().split('T')[0]!;
        let fromDate: string;

        if (isFirstRun) {
          // 1st run: fetch historySyncDays ago (default 365 days / 1 year) to today
          const historyDaysAgo = new Date(now.getTime() - this.historySyncDays * 24 * 60 * 60 * 1000);
          fromDate = historyDaysAgo.toISOString().split('T')[0]!;
          console.log(`📅 [Poller] First sync for ${symbol}: querying ${this.historySyncDays}-day history (${fromDate} to ${toDate})...`);
        } else {
          // Subsequent run: fetch after the last sync date (with 24h buffer for timezone/reporting overlap) to today
          // e.g. If last sync was 10 days ago, fetches from 11 days ago to today.
          // e.g. If last sync was 1 minute ago, fetches from yesterday to today.
          const oneDayBuffer = 24 * 60 * 60 * 1000;
          const syncBaseDate = lastSyncDate ?? new Date(now.getTime() - oneDayBuffer);
          const syncFrom = new Date(Math.max(
            now.getTime() - this.historySyncDays * 24 * 60 * 60 * 1000, // safety cap at historySyncDays max
            syncBaseDate.getTime() - oneDayBuffer
          ));
          fromDate = syncFrom.toISOString().split('T')[0]!;
        }

        const articles = await this.finnhubClient.fetchCompanyNews(symbol, fromDate, toDate);
        await this.processArticlesForSymbol(symbol, articles, isFirstRun);

        // Persist successful sync timestamp in MongoDB Atlas
        await this.storage.setLastSyncDate(symbol, now, articles.length);
        this.seededSymbols.add(symbol);
      } catch (error) {
        console.error(`❌ [Poller] Error polling news for ${symbol}:`, error instanceof Error ? error.message : error);
      }
    });
  }

  private async processArticlesForSymbol(
    symbol: string,
    articles: FinnhubNewsArticle[],
    isFirstRun: boolean
  ): Promise<void> {
    if (isFirstRun) {
      // Sort articles newest first
      const sorted = [...articles].sort((a, b) => b.datetime - a.datetime);

      // 1. Populate deduplication cache with all historical articles so we never alert on them
      for (const article of sorted) {
        this.deduplicator.add(article.id);
      }

      // 2. Classify top 3 newest articles with real Jev System 1 inference for the dashboard,
      // and pre-seed the rest with baseline routine representation
      const topArticles = sorted.slice(0, 3);
      const remainingArticles = sorted.slice(3);

      for (const article of topArticles) {
        const existing = await this.storage.getCachedPrediction(article.id);
        if (!existing) {
          try {
            const classification = await this.jevService.classifyArticleSentiment(article);
            await this.storage.savePrediction(article, classification);
            console.log(`🧠 [Jev Seed] Evaluated recent headline for ${symbol} (#${article.id}): ${classification.label} (${classification.priority})`);
          } catch (jevErr) {
            console.warn(`⚠️ [Jev Seed] Jev seed classification failed for #${article.id}:`, jevErr instanceof Error ? jevErr.message : jevErr);
            await this.storage.savePrediction(article, {
              sentiment: 1,
              label: 'BULLISH',
              confidence: 0.8,
              probabilities: { bullish: 0.8, bearish: 0.2 },
              rawChoice: 'bullish',
              priority: 'ROUTINE_NOISE',
              priorityConfidence: 0.8,
              priorityProbabilities: { breaking_critical: 0.05, notable_catalyst: 0.15, routine_noise: 0.8 },
              isBreaking: false,
              urgencyScore: 0.125,
            });
          }
        }
      }

      for (const article of remainingArticles) {
        const existing = await this.storage.getCachedPrediction(article.id);
        if (!existing) {
          await this.storage.savePrediction(article, {
            sentiment: 1,
            label: 'BULLISH',
            confidence: 0.8,
            probabilities: { bullish: 0.8, bearish: 0.2 },
            rawChoice: 'bullish',
            priority: 'ROUTINE_NOISE',
            priorityConfidence: 0.8,
            priorityProbabilities: { breaking_critical: 0.05, notable_catalyst: 0.15, routine_noise: 0.8 },
            isBreaking: false,
            urgencyScore: 0.125,
          });
        }
      }

      console.log(
        `🌱 [Poller] Seeded ${this.historySyncDays}-day baseline for ${symbol}: ${articles.length} historical articles loaded into storage & cache.`
      );
      return;
    }

    // Subsequent runs (including gap catch-up): process from oldest to newest
    const sortedArticles = [...articles].sort((a, b) => a.datetime - b.datetime);

    for (const article of sortedArticles) {
      if (this.deduplicator.has(article.id)) {
        continue;
      }

      this.deduplicator.add(article.id);
      this.articlesSeen++;

      // Check article age: if it occurred during a long server downtime (> 24 hours ago),
      // we backfill it into MongoDB for the dashboard without blasting Telegram notifications
      const articleAgeHours = (Date.now() - article.datetime * 1000) / (60 * 60 * 1000);
      const isFresh = articleAgeHours <= 24;

      console.log(
        `✨ [Poller] New article detected for ${symbol} (#${article.id}): "${article.headline.substring(0, 60)}..."`
      );

      try {
        // 1. Check Centralized MongoDB Shared Prediction Cache
        let classification: JevSentimentResult;

        const cached = await this.storage.getCachedPrediction(article.id);
        if (cached) {
          this.cacheHits++;
          classification = {
            sentiment: cached.sentiment,
            label: cached.label,
            confidence: cached.confidence,
            probabilities: cached.probabilities,
            rawChoice: cached.rawChoice,
            priority: cached.priority || 'ROUTINE_NOISE',
            priorityConfidence: cached.priorityConfidence || 0.8,
            priorityProbabilities: {
              breaking_critical: cached.priority === 'BREAKING_CRITICAL' ? 0.9 : 0.05,
              notable_catalyst: cached.priority === 'NOTABLE_CATALYST' ? 0.8 : 0.15,
              routine_noise: cached.priority === 'ROUTINE_NOISE' ? 0.8 : 0.1,
            },
            isBreaking: cached.isBreaking ?? false,
            urgencyScore: cached.urgencyScore ?? 0.1,
          };
          console.log(`♻️ [Mongo Cache] Reusing shared prediction for #${article.id}: ${classification.label} (${classification.priority}) | Conf: ${(classification.confidence * 100).toFixed(1)}%`);
        } else {
          // 2. Classify via Jev System 1 Model
          classification = await this.jevService.classifyArticleSentiment(article);
          await this.storage.savePrediction(article, classification);
          console.log(`🧠 [Jev] Decision for #${article.id}: ${classification.label} (${classification.sentiment}) | Priority: ${classification.priority} (${(classification.urgencyScore * 100).toFixed(0)}% urgency) | Conf: ${(classification.confidence * 100).toFixed(1)}%`);
        }

        // If the article occurred during a previous downtime gap (> 24h ago), backfill quietly into DB
        if (!isFresh) {
          console.log(`ℹ️ [Poller] Backfilled gap article #${article.id} for ${symbol} into MongoDB (age: ${Math.round(articleAgeHours)}h, skipping Telegram push).`);
          continue;
        }

        // 3. Confidence & Noise Filtering Check
        if (classification.confidence < this.minConfidence) {
          console.log(
            `⚠️ [Poller] Skipping alert for #${article.id}: Confidence ${(classification.confidence * 100).toFixed(1)}% < ${this.minConfidence * 100}% threshold`
          );
          continue;
        }

        // Filter out routine noise from push notifications to prevent fatigue (still stored in Mongo & Dashboard)
        if (classification.priority === 'ROUTINE_NOISE' && classification.urgencyScore < 0.35) {
          console.log(
            `ℹ️ [Poller] Saved routine noise #${article.id} for ${symbol} to DB (skipping Telegram push to prevent alert fatigue).`
          );
          continue;
        }

        // 4. Format Telegram alert HTML
        const alertHtml = formatNewsAlertHtml(article, classification);

        if (this.telegramService.isEnabled) {
          // 5. ElevenLabs Voice Note generation (with Mongo audio caching)
          let voiceSent = false;
          if (this.enableVoiceAlerts && this.elevenlabsService.isEnabled) {
            try {
              // Check if audio was already synthesized and cached in Mongo
              let audioBuffer = await this.storage.getAudio(article.id);
              if (!audioBuffer) {
                audioBuffer = await this.elevenlabsService.generateAlertVoice(
                  article.related,
                  classification.label,
                  article.headline,
                  Math.round(classification.confidence * 100)
                );
                if (audioBuffer) {
                  await this.storage.saveAudio(article.id, audioBuffer);
                }
              } else {
                console.log(`♻️ [Mongo Audio] Reusing cached ElevenLabs audio for #${article.id}`);
              }

              if (audioBuffer) {
                await this.telegramService.sendVoiceAlert(audioBuffer, alertHtml);
                this.voiceAlertsSent++;
                voiceSent = true;
                console.log(`🎙 [ElevenLabs] Voice alert delivered for ${symbol} (#${article.id})`);
              }
            } catch (voiceErr) {
              console.warn(`⚠️ [ElevenLabs] Voice dispatch failed, falling back to text:`, voiceErr instanceof Error ? voiceErr.message : voiceErr);
            }
          }

          // If voice wasn't dispatched, dispatch standard HTML text alert
          if (!voiceSent) {
            await this.telegramService.sendAlert(alertHtml);
            console.log(`📨 [Telegram] Alert delivered for ${symbol} (#${article.id})`);
          }

          this.alertsSent++;
        } else {
          console.log(`📱 [Poller] Signal recorded for ${symbol} (#${article.id}) (Telegram push notifications disabled).`);
        }
      } catch (err) {
        console.error(
          `❌ [Poller] Error evaluating/alerting article #${article.id} for ${symbol}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
}
