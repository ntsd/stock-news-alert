import dotenv from 'dotenv';
import { z } from 'zod';
import type { AppConfig } from '../types/config.js';

// Load environment variables from .env file
dotenv.config();

export const envSchema = z.object({
  FINNHUB_API_KEY: z
    .string()
    .min(1, 'FINNHUB_API_KEY cannot be empty'),

  TYPESAFE_API_KEY: z
    .string()
    .min(1, 'TYPESAFE_API_KEY cannot be empty'),

  TELEGRAM_BOT_TOKEN: z
    .string()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined))
    .refine((val) => !val || /^\d+:[A-Za-z0-9_-]+$/.test(val), {
      message: 'TELEGRAM_BOT_TOKEN must match format <bot_id>:<token>',
    }),

  TELEGRAM_CHAT_ID: z
    .string()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined)),

  WATCHLIST: z
    .string()
    .optional()
    .default('AAPL,MSFT,NVDA,GOOGL,AMZN,META,TSLA,AMD,AVGO,QCOM,TSM,ARM,PLTR,NFLX,CRM,ORCL,COIN,UBER,BABA,TCEHY,BYDDY,BIDU,JD,PDD,NIO,LI')
    .transform((val) =>
      val
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    ),

  POLL_INTERVAL_MS: z
    .string()
    .optional()
    .default('2200')
    .transform((val) => Number.parseInt(val, 10))
    .refine((val) => !Number.isNaN(val) && val >= 1000, {
      message: 'POLL_INTERVAL_MS must be an integer >= 1000ms (to honor 60 req/min limit)',
    }),

  MIN_CONFIDENCE: z
    .string()
    .optional()
    .default('0.0')
    .transform((val) => Number.parseFloat(val))
    .refine((val) => !Number.isNaN(val) && val >= 0 && val <= 1, {
      message: 'MIN_CONFIDENCE must be a float between 0.0 and 1.0',
    }),

  PORT: z
    .string()
    .optional()
    .default('3000')
    .transform((val) => Number.parseInt(val, 10))
    .refine((val) => !Number.isNaN(val) && val > 0 && val < 65536, {
      message: 'PORT must be a valid port number (1-65535)',
    }),

  HISTORY_SYNC_DAYS: z
    .string()
    .optional()
    .default('7')
    .transform((val) => Number.parseInt(val, 10))
    .refine((val) => !Number.isNaN(val) && val >= 1 && val <= 1825, {
      message: 'HISTORY_SYNC_DAYS must be an integer between 1 and 1825 days (up to 5 years)',
    }),

  ENABLE_HEALTH_SERVER: z
    .string()
    .optional()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true' || val === '1'),

  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .optional()
    .default('development'),

  // Sentry Observability
  SENTRY_DSN: z
    .string()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined)),

  // ElevenLabs Voice Alerts
  ELEVENLABS_API_KEY: z
    .string()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined)),

  ELEVENLABS_VOICE_ID: z
    .string()
    .optional()
    .default('pNInz6obpgDQGcFmaJgB'), // Adam - authoritative news reader voice

  ENABLE_VOICE_ALERTS: z
    .string()
    .optional()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true' || val === '1'),

  // Centralized MongoDB Prediction Storage
  MONGODB_URI: z
    .string()
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val.trim() : undefined)),

  MONGODB_DATABASE: z
    .string()
    .optional()
    .default('zero_market_radar'),
});

export function loadAndValidateConfig(): AppConfig {
  const parseResult = envSchema.safeParse(process.env);

  if (!parseResult.success) {
    const formattedErrors = parseResult.error.issues.map(
      (issue) => ` - [${issue.path.join('.')}] ${issue.message}`
    );
    console.error('❌ Environment validation failed with the following errors:');
    console.error(formattedErrors.join('\n'));
    console.error('\nPlease check your .env file or deployment environment variables.\n');
    process.exit(1);
  }

  const { data } = parseResult;

  if (data.WATCHLIST.length === 0) {
    console.error('❌ WATCHLIST cannot be empty. Please specify at least one symbol.');
    process.exit(1);
  }

  return {
    finnhubApiKey: data.FINNHUB_API_KEY,
    typesafeApiKey: data.TYPESAFE_API_KEY,
    telegramBotToken: data.TELEGRAM_BOT_TOKEN,
    telegramChatId: data.TELEGRAM_CHAT_ID,
    enableTelegramAlerts: !!(data.TELEGRAM_BOT_TOKEN && data.TELEGRAM_CHAT_ID),
    watchlist: data.WATCHLIST,
    pollIntervalMs: data.POLL_INTERVAL_MS,
    minConfidence: data.MIN_CONFIDENCE,
    port: data.PORT,
    historySyncDays: data.HISTORY_SYNC_DAYS,
    enableHealthServer: data.ENABLE_HEALTH_SERVER,
    nodeEnv: data.NODE_ENV,
    sentryDsn: data.SENTRY_DSN,
    elevenlabsApiKey: data.ELEVENLABS_API_KEY,
    elevenlabsVoiceId: data.ELEVENLABS_VOICE_ID,
    enableVoiceAlerts: data.ENABLE_VOICE_ALERTS && !!data.ELEVENLABS_API_KEY,
    mongodbUri: data.MONGODB_URI,
    mongodbDatabaseName: data.MONGODB_DATABASE,
  };
}

export const config: AppConfig = loadAndValidateConfig();
