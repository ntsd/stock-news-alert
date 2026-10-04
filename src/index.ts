import { config } from './config/env.js';
import { initSentry } from './instrumentation/sentry.js';
import { FinnhubClient } from './services/finnhub.js';
import { JevClassificationService } from './services/jev.js';
import { TelegramAlertService } from './services/telegram.js';
import { ElevenLabsService } from './services/elevenlabs.js';
import { PredictionStorageService } from './services/mongodb.js';
import { BoundedTtlLruCache } from './cache/lru.js';
import { NewsAlertPoller } from './scheduler/poller.js';
import { createWebServer } from './server/webServer.js';

console.log('=====================================================');
console.log('📈 Starting stock-news-alert Production Service');
console.log(`🌍 Environment: ${config.nodeEnv}`);
console.log(`📋 Watchlist: [${config.watchlist.join(', ')}]`);
console.log(`🎯 Min Confidence Filter: ${config.minConfidence * 100}%`);
console.log(`🎙 ElevenLabs Voice Alerts: ${config.enableVoiceAlerts ? 'ENABLED' : 'DISABLED'}`);
console.log(`🛡 Sentry Agent Tracing: ${config.sentryDsn ? 'ENABLED' : 'LOCAL'}`);
console.log(`🗄 MongoDB Central Cache: ${config.mongodbUri ? 'CLUSTER' : 'MEMORY_STORE'}`);
console.log('=====================================================');

// 1. Initialize Sentry Observability
initSentry(config.sentryDsn, config.nodeEnv);

// 2. Initialize Centralized Prediction Storage
const storage = new PredictionStorageService(
  config.mongodbUri,
  config.mongodbDatabaseName
);
await storage.init();

// 3. Initialize core services & clients
const finnhubClient = new FinnhubClient(config.finnhubApiKey);
const jevService = new JevClassificationService(config.typesafeApiKey);
const elevenlabsService = new ElevenLabsService(
  config.elevenlabsApiKey,
  config.elevenlabsVoiceId
);
const telegramService = new TelegramAlertService(
  config.telegramBotToken,
  config.telegramChatId
);
const deduplicator = new BoundedTtlLruCache(10000, 48 * 60 * 60 * 1000);

// 4. Initialize round-robin scheduler
const poller = new NewsAlertPoller({
  watchlist: config.watchlist,
  pollIntervalMs: config.pollIntervalMs,
  minConfidence: config.minConfidence,
  enableVoiceAlerts: config.enableVoiceAlerts,
  finnhubClient,
  jevService,
  telegramService,
  storage,
  elevenlabsService,
  deduplicator,
});

// 5. Start Web Dashboard and API server (for Render web service monitoring & UI)
let webServer: ReturnType<typeof createWebServer> | null = null;
if (config.enableHealthServer) {
  webServer = createWebServer({
    port: config.port,
    watchlist: config.watchlist,
    poller,
    storage,
    elevenlabsService,
  });
}

// 6. Start polling loop
poller.start();

// 7. Handle graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Initiating graceful shutdown...`);
  poller.stop();

  try {
    await storage.close();
  } catch (err) {
    console.error('Error closing storage:', err);
  }

  if (webServer) {
    webServer.close(() => {
      console.log('🌐 [Web] Dashboard & API server closed.');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }

  // Force exit after 5 seconds if lingering handles remain
  setTimeout(() => {
    console.error('⚠️ Forcefully exiting after shutdown timeout.');
    process.exit(1);
  }, 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
