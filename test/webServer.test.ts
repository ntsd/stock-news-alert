import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebServer } from '../src/server/webServer.js';
import { PredictionStorageService } from '../src/services/mongodb.js';
import { ElevenLabsService } from '../src/services/elevenlabs.js';

describe('Web Server & API Endpoints', () => {
  let server: http.Server;
  let storage: PredictionStorageService;
  const port = 3888;

  const mockPoller: any = {
    getStats: () => ({
      isRunning: true,
      totalPolls: 50,
      articlesSeen: 20,
      alertsSent: 4,
      voiceAlertsSent: 2,
      cacheHits: 10,
      lastPollTime: new Date().toISOString(),
      currentSymbol: 'NVDA',
      watchlistSize: 4,
      cacheSize: 20,
      seededSymbols: ['NVDA', 'AAPL', 'TSLA', 'MSFT'],
    }),
  };

  const get = (path: string): Promise<{ status: number; data: any; raw: string }> => {
    return new Promise((resolve, reject) => {
      http.get(`http://localhost:${port}${path}`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(body);
          } catch {
            // HTML or raw text
          }
          resolve({ status: res.statusCode || 0, data, raw: body });
        });
        res.on('error', reject);
      });
    });
  };

  before(async () => {
    storage = new PredictionStorageService();
    await storage.init();

    // Seed mock predictions
    await storage.savePrediction(
      {
        category: 'company',
        datetime: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        headline: 'NVDA Quantum Architecture Announcement',
        id: 7001,
        image: '',
        related: 'NVDA',
        source: 'Reuters',
        summary: 'NVIDIA reveals quantum breakthrough.',
        url: 'https://example.com/nvda',
      },
      {
        sentiment: 1,
        label: 'BULLISH',
        confidence: 0.98,
        probabilities: { bullish: 0.98, bearish: 0.02 },
        rawChoice: 'bullish',
        priority: 'BREAKING_CRITICAL',
        priorityConfidence: 0.96,
        priorityProbabilities: { breaking_critical: 0.96, notable_catalyst: 0.03, routine_noise: 0.01 },
        isBreaking: true,
        urgencyScore: 0.97,
      }
    );

    await storage.savePrediction(
      {
        category: 'company',
        datetime: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
        headline: 'AAPL Expands Services Ecosystem',
        id: 7002,
        image: '',
        related: 'AAPL',
        source: 'Bloomberg',
        summary: 'Apple reports growth across digital services.',
        url: 'https://example.com/aapl',
      },
      {
        sentiment: 1,
        label: 'BULLISH',
        confidence: 0.88,
        probabilities: { bullish: 0.88, bearish: 0.12 },
        rawChoice: 'bullish',
        priority: 'NOTABLE_CATALYST',
        priorityConfidence: 0.85,
        priorityProbabilities: { breaking_critical: 0.1, notable_catalyst: 0.8, routine_noise: 0.1 },
        isBreaking: false,
        urgencyScore: 0.65,
      }
    );

    const elevenlabs = new ElevenLabsService();
    server = createWebServer({
      port,
      watchlist: ['NVDA', 'AAPL', 'TSLA', 'MSFT'],
      poller: mockPoller,
      storage,
      elevenlabsService: elevenlabs,
    });
  });

  after(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (storage) {
      await storage.close();
    }
  });

  it('should respond with health metrics at /health', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'healthy');
    assert.equal(res.data.service, 'zero-market-radar');
  });

  it('should filter top stocks by interest symbols query parameter', async () => {
    const res = await get('/api/stocks?symbols=NVDA,AAPL');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.stocks));
    const symbols = res.data.stocks.map((s: any) => s.symbol);
    assert.ok(symbols.includes('NVDA'));
    assert.ok(symbols.includes('AAPL'));
    assert.ok(!symbols.includes('TSLA'));
  });

  it('should return top news on interest symbols ordered by impact at /api/top-news', async () => {
    const res = await get('/api/top-news?symbols=NVDA,AAPL&limit=4');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.topNews));
    assert.ok(res.data.topNews.length >= 2);
    // Highest impact first (NVDA 0.97 > AAPL 0.65)
    assert.equal(res.data.topNews[0].symbol, 'NVDA');
  });

  it('should support news ordering by impact at /api/news?sortBy=impact', async () => {
    const res = await get('/api/news?sortBy=impact&limit=10');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.news));
    assert.ok(res.data.news.length >= 2);
    assert.equal(res.data.news[0]._id, 7001);
  });

  it('should support date range filtering at /api/news?fromDate=...&toDate=...', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const res = await get(`/api/news?fromDate=${yesterday}&toDate=${tomorrow}`);
    assert.equal(res.status, 200);
    assert.ok(res.data.news.length >= 2);

    // Old date range should yield 0 results
    const pastRes = await get('/api/news?fromDate=2020-01-01&toDate=2020-01-02');
    assert.equal(pastRes.status, 200);
    assert.equal(pastRes.data.news.length, 0);
  });

  it('should render the dashboard HTML with interest symbol filters and impact controls', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('Zero Market Radar'));
    assert.ok(res.raw.includes('Watched Interest Symbols'));
    assert.ok(res.raw.includes('Top Impact News on Watched Symbols'));
    assert.ok(res.raw.includes('Highest Impact (Urgency Score)'));
    assert.ok(res.raw.includes('3D (Default)'));
  });
});
