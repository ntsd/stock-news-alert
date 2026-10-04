export interface AppConfig {
  finnhubApiKey: string;
  typesafeApiKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  watchlist: string[];
  pollIntervalMs: number;
  minConfidence: number;
  port: number;
  enableHealthServer: boolean;
  nodeEnv: 'development' | 'production' | 'test';
}
