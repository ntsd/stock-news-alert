import type { TelegramApiResponse, TelegramSendMessagePayload } from '../types/telegram.js';
import { withExponentialBackoff } from '../utils/retry.js';

export class TelegramAlertService {
  private readonly botToken: string;
  private readonly defaultChatId: string;
  private readonly baseUrl: string;

  // Queue to ensure strict compliance with Telegram's 1 message/sec per chat limit
  private readonly sendQueue: Array<() => Promise<void>> = [];
  private isProcessingQueue = false;
  private lastSendTime = 0;
  private readonly minIntervalMs = 1000;

  constructor(botToken: string, defaultChatId: string) {
    this.botToken = botToken;
    this.defaultChatId = defaultChatId;
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  /**
   * Enqueues an HTML formatted message to be dispatched to Telegram.
   */
  public async sendAlert(htmlText: string, chatId?: string): Promise<void> {
    const targetChatId = chatId || this.defaultChatId;

    return new Promise<void>((resolve, reject) => {
      this.sendQueue.push(async () => {
        try {
          await this.dispatchMessage(targetChatId, htmlText);
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.sendQueue.length > 0) {
      const task = this.sendQueue.shift();
      if (!task) break;

      // Rate limit throttle: ensure at least minIntervalMs elapsed since last dispatch
      const elapsed = Date.now() - this.lastSendTime;
      if (elapsed < this.minIntervalMs) {
        await new Promise((res) => setTimeout(res, this.minIntervalMs - elapsed));
      }

      try {
        await task();
        this.lastSendTime = Date.now();
      } catch (err) {
        console.error('[TelegramService] Error dispatching message from queue:', err);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Dispatches a single message with exponential backoff and 429 Retry-After handling.
   */
  private async dispatchMessage(chatId: string, htmlText: string): Promise<void> {
    const payload: TelegramSendMessagePayload = {
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };

    await withExponentialBackoff(
      async () => {
        const response = await fetch(`${this.baseUrl}/sendMessage`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });

        const data = (await response.json()) as TelegramApiResponse;

        if (!response.ok || !data.ok) {
          // If Telegram signals rate limiting with retry_after
          if (response.status === 429 && data.parameters?.retry_after) {
            const retryAfterSec = data.parameters.retry_after;
            console.warn(`[TelegramService] Rate limited (429). Waiting ${retryAfterSec}s...`);
            await new Promise((res) => setTimeout(res, retryAfterSec * 1000));
            throw new Error(`Telegram 429 Rate Limit (waited ${retryAfterSec}s)`);
          }

          throw new Error(
            `Telegram API error (${data.error_code ?? response.status}): ${data.description || 'Unknown error'}`
          );
        }
      },
      {
        name: 'Telegram:sendMessage',
        maxAttempts: 3,
        initialDelayMs: 1500,
      }
    );
  }
}
