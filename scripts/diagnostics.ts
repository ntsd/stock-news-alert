import dotenv from 'dotenv';
import { FinnhubClient } from '../src/services/finnhub.js';
import { JevClassificationService } from '../src/services/jev.js';
import { ElevenLabsService } from '../src/services/elevenlabs.js';
import { TelegramAlertService } from '../src/services/telegram.js';
import { PredictionStorageService } from '../src/services/mongodb.js';
import { initSentry, traceSpan } from '../src/instrumentation/sentry.js';
import { config } from '../src/config/env.js';

dotenv.config();

async function runDiagnostics() {
  console.log('🧪 Starting Full System Integration Diagnostics...\n');

  // 1. Sentry
  console.log('1️⃣ Testing Sentry Initialization...');
  try {
    initSentry(config.sentryDsn, 'test');
    await traceSpan('diagnostics.test_span', 'diagnostics', { test: true }, async () => {
      console.log('   ✅ Sentry test span created successfully.');
    });
  } catch (err: any) {
    console.error('   ❌ Sentry error:', err.message);
  }

  // 2. ElevenLabs
  console.log('\n2️⃣ Testing ElevenLabs Text-to-Speech...');
  const eleven = new ElevenLabsService(config.elevenlabsApiKey, config.elevenlabsVoiceId);
  let audioBuffer: Buffer | null = null;
  if (eleven.isEnabled) {
    try {
      audioBuffer = await eleven.generateAlertVoice('AAPL', 'BULLISH', 'Apple reports breakthrough quarterly earnings', 95);
      if (audioBuffer && audioBuffer.length > 0) {
        console.log(`   ✅ ElevenLabs TTS succeeded! Generated ${audioBuffer.length} bytes of MP3 audio.`);
      } else {
        console.warn('   ⚠️ ElevenLabs returned empty buffer.');
      }
    } catch (err: any) {
      console.error('   ❌ ElevenLabs TTS error:', err.message);
    }
  } else {
    console.log('   ⚠️ ElevenLabs is disabled.');
  }

  // 3. Telegram
  console.log('\n3️⃣ Testing Telegram Delivery...');
  const telegram = new TelegramAlertService(config.telegramBotToken, config.telegramChatId);
  try {
    if (audioBuffer) {
      console.log('   Sending voice alert to Telegram...');
      await telegram.sendVoiceAlert(audioBuffer, '🎙 <b>[TEST]</b> ElevenLabs audio test alert for Stock News Alert!');
      console.log('   ✅ Telegram voice memo delivered successfully!');
    } else {
      await telegram.sendAlert('🔔 <b>[TEST]</b> Text test alert for Stock News Alert!');
      console.log('   ✅ Telegram text message delivered successfully!');
    }
  } catch (err: any) {
    console.error('   ❌ Telegram delivery error:', err.message);
  }

  // 4. Finnhub
  console.log('\n4️⃣ Testing Finnhub API...');
  const finnhub = new FinnhubClient(config.finnhubApiKey);
  try {
    const articles = await finnhub.fetchCompanyNews('AAPL');
    console.log(`   ✅ Finnhub returned ${articles.length} news articles for AAPL.`);
  } catch (err: any) {
    console.error('   ❌ Finnhub error:', err.message);
  }

  // 5. TypeSafe Jev
  console.log('\n5️⃣ Testing TypeSafe AI Jev Decision Model...');
  const jev = new JevClassificationService(config.typesafeApiKey);
  try {
    const decision = await jev.classifyArticleSentiment({
      category: 'company',
      datetime: Math.floor(Date.now() / 1000),
      headline: 'Apple raises dividend by 15% following record iPhone gross margins',
      id: 1234567,
      image: '',
      related: 'AAPL',
      source: 'Finnhub',
      summary: 'Apple Inc announced strong revenue beat across all hardware segments.',
      url: 'https://apple.com',
    });
    console.log(`   ✅ Jev classified sentiment: ${decision.label} (${decision.sentiment}) with ${(decision.confidence * 100).toFixed(1)}% confidence.`);
  } catch (err: any) {
    console.error('   ❌ Jev error:', err.message);
  }

  // 6. MongoDB
  console.log('\n6️⃣ Testing MongoDB Connection...');
  const storage = new PredictionStorageService(config.mongodbUri, config.mongodbDatabaseName);
  try {
    await storage.init();
    await storage.close();
  } catch (err: any) {
    console.error('   ❌ MongoDB error:', err.message);
  }

  console.log('\n🏁 Diagnostics complete.');
}

runDiagnostics().catch(console.error);
