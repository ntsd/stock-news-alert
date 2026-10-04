import { config } from './config/env.js';
import { FinnhubClient } from './services/finnhub.js';
import { JevClassificationService } from './services/jev.js';
import { TelegramAlertService } from './services/telegram.js';
import { BoundedTtlLruCache } from './cache/lru.js';
import { NewsAlertPoller } from './scheduler/poller.js';
import { createHealthServer } from './server/health.js';

console.log('=====================================================');
console.log('📈 Starting stock-news-alert Production Service');
console.log(`🌍 Environment: ${config.nodeEnv}`);
console.log(`📋 Watchlist: [${config.watchlist.join(', ')}]`);
console.log(`🎯 Min Confidence Filter: ${config.minConfidence * 100}%`);
console.log('=====================================================');

// 1. Initialize core infrastructure & clients
const finnhubClient = new FinnhubClient(config.finnhubApiKey);
const jevService = new JevClassificationService(config.typesafeApiKey);
const telegramService = new TelegramAlertService(
  config.telegramBotToken,
  config.telegramChatId
);
const deduplicator = new BoundedTtlLruCache(10000, 48 * 60 * 60 * 1000);

// 2. Initialize round-robin scheduler
const poller = new NewsAlertPoller({
  watchlist: config.watchlist,
  pollIntervalMs: config.pollIntervalMs,
  minConfidence: config.minConfidence,
  finnhubClient,
  jevService,
  telegramService,
  deduplicator,
});

// 3. Start health server (for Render web service monitoring)
let healthServer: ReturnType<typeof createHealthServer> | null = null;
if (config.enableHealthServer) {
  healthServer = createHealthServer({
    port: config.port,
    getStats: () => poller.getStats(),
  });
}

// 4. Start polling loop
poller.start();

// 5. Handle graceful shutdown
const shutdown = (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Initiating graceful shutdown...`);
  poller.stop();

  if (healthServer) {
    healthServer.close(() => {
      console.log('🩺 [Health] Health server closed.');
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
