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

  // Sentry Observability
  sentryDsn?: string;

  // ElevenLabs Voice Alerts
  elevenlabsApiKey?: string;
  elevenlabsVoiceId: string;
  enableVoiceAlerts: boolean;

  // Centralized MongoDB Prediction Storage
  mongodbUri?: string;
  mongodbDatabaseName: string;
}
