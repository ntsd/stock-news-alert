import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NewsAlertPoller } from '../scheduler/poller.js';
import type { PredictionStorageService } from '../services/mongodb.js';
import type { ElevenLabsService } from '../services/elevenlabs.js';
import type { FinnhubClient } from '../services/finnhub.js';
import { PriceHistoryService } from '../services/priceHistory.js';

export interface WebServerOptions {
  port: number;
  watchlist: string[];
  poller: NewsAlertPoller;
  storage: PredictionStorageService;
  elevenlabsService: ElevenLabsService;
  finnhubClient?: FinnhubClient;
  priceHistoryService?: PriceHistoryService;
}

// ponytail: vendored from node_modules at request time (no build step, no new dependency).
// Upgrade path: emit the file to disk at boot or serve a CDN copy if node_modules layout changes.
function loadLightweightChartsScript(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', '..', 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'),
    path.join(here, '..', 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'),
  ];
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      // try next candidate
    }
  }
  return null;
}

export function createWebServer(options: WebServerOptions): http.Server {
  const { port, watchlist, poller, storage, elevenlabsService, finnhubClient } = options;
  const priceHistory = options.priceHistoryService ?? (finnhubClient ? new PriceHistoryService(storage, finnhubClient) : null);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Enable CORS for API requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // 0. Vendored TradingView Lightweight Charts browser build (served from node_modules)
      if (url.pathname === '/vendor/lightweight-charts.js') {
        const script = loadLightweightChartsScript();
        if (!script) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'lightweight-charts build not found in node_modules' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(script);
        return;
      }

      // 1. Health check endpoint (for Render Blueprint zero-downtime health monitoring)
      if (url.pathname === '/health') {
        const stats = poller.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(
          JSON.stringify(
            {
              status: stats.isRunning ? 'healthy' : 'stopped',
              service: 'zero-market-radar',
              uptimeSeconds: Math.floor(process.uptime()),
              timestamp: new Date().toISOString(),
              stats,
            },
            null,
            2
          )
        );
        return;
      }

      // 2. Telemetry stats endpoint
      if (url.pathname === '/api/stats') {
        const stats = poller.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            uptimeSeconds: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            pollerStats: stats,
            watchlist,
            elevenlabsEnabled: elevenlabsService.isEnabled,
          })
        );
        return;
      }

      // 3. Top Stocks Watching endpoint (filtered by optional symbols)
      if (url.pathname === '/api/stocks') {
        const symbolsParam = url.searchParams.get('symbols');
        const targetList = symbolsParam
          ? symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0)
          : watchlist;
        const stocks = await storage.getTopStocks(targetList);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ stocks }));
        return;
      }

      // 4. Top News Spotlight on Interest Symbols (ordered by highest impact)
      if (url.pathname === '/api/top-news') {
        const symbolsParam = url.searchParams.get('symbols');
        const symbols = symbolsParam
          ? symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0)
          : watchlist;
        const fromDate = url.searchParams.get('fromDate') || undefined;
        const toDate = url.searchParams.get('toDate') || undefined;
        const limit = Number.parseInt(url.searchParams.get('limit') || '4', 10);

        const topNews = await storage.getRecentNews({
          limit,
          symbols,
          fromDate,
          toDate,
          sortBy: 'impact',
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ topNews }));
        return;
      }

      // 5. News feed endpoint (filter by symbol, symbols, sentiment, priority, breaking, date range, sort)
      if (url.pathname === '/api/news') {
        const symbol = url.searchParams.get('symbol') || undefined;
        const symbolsParam = url.searchParams.get('symbols');
        const symbols = symbolsParam
          ? symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0)
          : undefined;
        const sentimentParam = url.searchParams.get('sentiment');
        const sentiment = sentimentParam !== null && sentimentParam !== '' ? (Number.parseInt(sentimentParam, 10) as 1 | 0) : undefined;
        const priorityParam = url.searchParams.get('priority') as 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE' | null;
        const priority = priorityParam || undefined;
        const breakingOnly = url.searchParams.get('breaking') === 'true';
        const fromDate = url.searchParams.get('fromDate') || undefined;
        const toDate = url.searchParams.get('toDate') || undefined;
        const sortBy = (url.searchParams.get('sortBy') as 'date' | 'impact' | 'confidence') || 'date';
        const limit = Number(url.searchParams.get('limit') ?? '50');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
          || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'limit must be 1–200 and offset must be 0–1000000 integers' }));
          return;
        }

        const news = await storage.getRecentNews({
          limit: limit + 1,
          offset,
          symbol,
          symbols,
          sentiment,
          priority,
          breakingOnly,
          fromDate,
          toDate,
          sortBy,
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ news: news.slice(0, limit), hasMore: news.length > limit, offset, limit }));
        return;
      }

      // 6. ElevenLabs Audio Stream endpoint on-demand (with MongoDB audio cache)
      if (url.pathname.startsWith('/api/audio/')) {
        const articleId = Number.parseInt(url.pathname.replace('/api/audio/', ''), 10);
        const article = await storage.getCachedPrediction(articleId);

        if (!article) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Article not found' }));
          return;
        }

        // Enforce eligibility before reading even previously cached catalyst audio.
        const isVoiceEligible = article.priority === 'BREAKING_CRITICAL';
        if (!isVoiceEligible) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'Audio voice synthesis is only available for breaking critical news.',
            })
          );
          return;
        }

        // 1. Check if audio is already cached in MongoDB
        const cachedAudio = await storage.getAudio(articleId);
        if (cachedAudio) {
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': cachedAudio.length,
            'Cache-Control': 'public, max-age=86400',
          });
          res.end(cachedAudio);
          return;
        }

        // 2. Otherwise generate via ElevenLabs if key configured
        if (!elevenlabsService.isEnabled) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ElevenLabs API key not configured' }));
          return;
        }

        const audio = await elevenlabsService.generateAlertVoice(
          article.symbol,
          article.label,
          article.headline,
          Math.round(article.confidence * 100)
        );

        if (!audio) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to generate audio' }));
          return;
        }

        // 3. Cache generated audio in MongoDB for future instant plays
        await storage.saveAudio(articleId, audio);

        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audio.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(audio);
        return;
      }

      // 7. Real-Time Price Quote endpoint for a symbol
      if (url.pathname.startsWith('/api/quote/')) {
        const symbol = url.pathname.replace('/api/quote/', '').trim().toUpperCase();
        let quote = await storage.getQuote(symbol);
        if (!quote && finnhubClient) {
          quote = await finnhubClient.fetchQuote(symbol);
          if (quote) {
            await storage.saveQuote(quote);
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ quote }));
        return;
      }

      // 8. Symbol Price Chart & Published News endpoint
      if (url.pathname.startsWith('/api/chart/')) {
        const symbol = url.pathname.replace('/api/chart/', '').trim().toUpperCase();
        const range = url.searchParams.get('range') || '7d';
        if (!/^[A-Z0-9.^=-]{1,20}$/.test(symbol) || !['24h', '1d', '7d', '30d', '90d', '1y'].includes(range)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid chart symbol or range' }));
          return;
        }

        let quote = await storage.getQuote(symbol);
        if (!quote && finnhubClient) {
          quote = await finnhubClient.fetchQuote(symbol);
          if (quote) {
            await storage.saveQuote(quote);
          }
        }

        const history = priceHistory
          ? await priceHistory.get(symbol, range)
          : { candles: [], stale: true, fetchedAt: null };
        const candles = history.candles;

        // Determine lookback for news articles based on range
        const now = Date.now();
        const rangeMs =
          range === '24h' || range === '1d'
            ? 24 * 3600 * 1000
            : range === '30d'
              ? 30 * 24 * 3600 * 1000
              : range === '90d'
                ? 90 * 24 * 3600 * 1000
                : range === '1y'
                  ? 365 * 24 * 3600 * 1000
                  : 7 * 24 * 3600 * 1000;
        const fromDate = new Date(now - rangeMs).toISOString().split('T')[0];

        const news = await storage.getRecentNews({
          symbol,
          fromDate,
          limit: 100,
          sortBy: 'date',
        });

        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ symbol, quote, candles, news, priceHistory: {
          stale: history.stale, fetchedAt: history.fetchedAt, provider: 'yahoo',
        } }));
        return;
      }

      // 9. Dedicated Symbol Page route: /symbol/:symbol
      if (url.pathname.startsWith('/symbol/')) {
        const symbol = url.pathname.replace('/symbol/', '').trim().toUpperCase();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboardHtml(watchlist, symbol));
        return;
      }

      // 10. Web Dashboard UI
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const symbol = url.searchParams.get('symbol')?.trim().toUpperCase() || undefined;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboardHtml(watchlist, symbol));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Route not found' }));
    } catch (err) {
      console.error('[WebServer] Error handling request:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    }
  });

  server.listen(port, () => {
    console.log(`🌐 [Web] Zero Market Radar Dashboard & API active at http://localhost:${port}`);
  });

  return server;
}

function renderDashboardHtml(defaultWatchlist: string[], initialSymbol?: string): string {
  const watchlistJson = JSON.stringify(defaultWatchlist);
  const initialSymbolJson = JSON.stringify(initialSymbol || '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zero Market Radar | System 1 AI Financial Terminal</title>
  <meta name="description" content="Sub-second stock news sentiment & urgency analysis powered by Zero Market Radar, TypeSafe AI Jev, ElevenLabs, MongoDB Atlas, and Render.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📈</text></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #080B11;
      --bg-surface: #0E131F;
      --bg-card: rgba(18, 24, 38, 0.75);
      --bg-card-hover: rgba(26, 34, 52, 0.90);
      --border-color: rgba(255, 255, 255, 0.08);
      --border-glow: rgba(99, 102, 241, 0.35);
      
      --text-main: #F3F4F6;
      --text-muted: #9CA3AF;
      --text-sub: #6B7280;

      --bullish-grad: linear-gradient(135deg, #10B981 0%, #059669 100%);
      --bullish-color: #10B981;
      --bullish-glow: rgba(16, 185, 129, 0.25);

      --bearish-grad: linear-gradient(135deg, #F43F5E 0%, #BE123C 100%);
      --bearish-color: #F43F5E;
      --bearish-glow: rgba(244, 63, 94, 0.25);

      --accent-indigo: #6366F1;
      --accent-cyan: #06B6D4;
      --accent-grad: linear-gradient(135deg, #6366F1 0%, #06B6D4 100%);
      --gold-grad: linear-gradient(135deg, #F59E0B 0%, #D97706 100%);
      --breaking-glow: 0 0 16px rgba(239, 68, 68, 0.4);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg-base);
      color: var(--text-main);
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      min-height: 100vh;
      line-height: 1.5;
      background-image: 
        radial-gradient(circle at 15% 12%, rgba(99, 102, 241, 0.10) 0%, transparent 45%),
        radial-gradient(circle at 85% 20%, rgba(6, 182, 212, 0.08) 0%, transparent 45%),
        radial-gradient(circle at 50% 90%, rgba(16, 185, 129, 0.05) 0%, transparent 50%);
    }

    .container {
      max-width: 1420px;
      margin: 0 auto;
      padding: 24px 20px 80px;
    }

    /* Header Bar */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 28px;
      flex-wrap: wrap;
      gap: 18px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .brand-icon {
      width: 48px;
      height: 48px;
      border-radius: 14px;
      background: var(--accent-grad);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4);
    }

    .brand h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #FFFFFF 30%, #CBD5E1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .status-badges {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
    }

    .badge-live {
      border-color: rgba(16, 185, 129, 0.35);
      color: #34D399;
      background: rgba(16, 185, 129, 0.08);
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      background: #10B981;
      border-radius: 50%;
      box-shadow: 0 0 10px #10B981;
      animation: pulse 1.8s infinite;
    }

    @keyframes pulse {
      0% { transform: scale(0.95); opacity: 0.8; }
      50% { transform: scale(1.25); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.8; }
    }

    .btn-refresh {
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.35);
      color: #A5B4FC;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
    }

    .btn-refresh:hover {
      background: rgba(99, 102, 241, 0.28);
      color: #FFF;
      border-color: #818CF8;
    }

    /* Section Headers */
    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .section-title {
      font-family: 'Outfit', sans-serif;
      font-size: 19px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #F8FAFC;
    }

    .section-subtitle {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 400;
    }

    .counter-badge {
      font-size: 12px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(99, 102, 241, 0.2);
      color: #A5B4FC;
      border: 1px solid rgba(99, 102, 241, 0.3);
      font-family: 'JetBrains Mono', monospace;
    }

    /* Interest Filter Panel */
    .interest-panel {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 18px 20px;
      margin-bottom: 32px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
    }

    .interest-top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .preset-pills {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .preset-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .preset-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      color: #FFF;
      border-color: rgba(255, 255, 255, 0.2);
    }

    .interest-search {
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--border-color);
      color: #FFF;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      outline: none;
      width: 180px;
      transition: border-color 0.2s;
    }

    .interest-search:focus {
      border-color: var(--accent-indigo);
    }

    .ticker-chips-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      max-height: 120px;
      overflow-y: auto;
      padding-right: 4px;
    }

    .ticker-chip {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.18s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }

    .ticker-chip:hover {
      border-color: rgba(99, 102, 241, 0.5);
      color: #FFF;
      transform: translateY(-1px);
    }

    .ticker-chip.active {
      background: rgba(99, 102, 241, 0.22);
      border-color: #818CF8;
      color: #EEF2FF;
      box-shadow: 0 0 12px rgba(99, 102, 241, 0.25);
    }

    .ticker-chip .check-icon {
      font-size: 11px;
      font-weight: 800;
      color: #818CF8;
    }

    /* Top News Spotlight Section */
    .top-news-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 16px;
      margin-bottom: 36px;
    }

    .spotlight-card {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 12px;
      position: relative;
      overflow: hidden;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .spotlight-card:hover {
      border-color: rgba(255, 255, 255, 0.2);
      background: var(--bg-card-hover);
      transform: translateY(-2px);
      box-shadow: 0 12px 28px -8px rgba(0, 0, 0, 0.6);
    }

    .spotlight-card.breaking {
      border-color: rgba(239, 68, 68, 0.4);
      box-shadow: var(--breaking-glow);
    }

    .spotlight-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }

    .spotlight-title {
      font-family: 'Outfit', sans-serif;
      font-size: 16px;
      font-weight: 600;
      color: #F8FAFC;
      line-height: 1.4;
      text-decoration: none;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .spotlight-title:hover {
      color: var(--accent-cyan);
      text-decoration: underline;
    }

    .spotlight-summary {
      font-size: 13px;
      color: #94A3B8;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    /* Urgency Meter */
    .urgency-meter-wrap {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 4px;
    }

    .urgency-meter-header {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-muted);
    }

    .urgency-meter-bar {
      height: 5px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
    }

    .urgency-meter-fill {
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, #6366F1 0%, #EC4899 50%, #EF4444 100%);
      transition: width 0.6s ease;
    }

    /* Top Stocks Grid */
    .stocks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 14px;
      margin-bottom: 36px;
    }

    .stock-card {
      background: var(--bg-card);
      backdrop-filter: blur(14px);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 16px;
      transition: all 0.22s ease;
      position: relative;
      cursor: pointer;
    }

    .stock-card:hover {
      background: var(--bg-card-hover);
      border-color: rgba(255, 255, 255, 0.2);
      transform: translateY(-2px);
      box-shadow: 0 10px 24px -10px rgba(0, 0, 0, 0.5);
    }

    .stock-card.interest-active {
      border-color: rgba(99, 102, 241, 0.45);
    }

    .stock-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .stock-symbol-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .stock-symbol {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      font-weight: 700;
      color: #FFF;
      letter-spacing: 0.5px;
    }

    .star-pin {
      cursor: pointer;
      font-size: 14px;
      color: rgba(255, 255, 255, 0.2);
      transition: all 0.18s ease;
    }

    .star-pin:hover {
      transform: scale(1.2);
      color: #FBBF24;
    }

    .star-pin.pinned {
      color: #FBBF24;
      text-shadow: 0 0 8px rgba(245, 158, 11, 0.6);
    }

    .stock-pill {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .pill-bullish {
      background: rgba(16, 185, 129, 0.15);
      color: #34D399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }

    .pill-bearish {
      background: rgba(244, 63, 94, 0.15);
      color: #FB7185;
      border: 1px solid rgba(244, 63, 94, 0.35);
    }

    .pill-breaking {
      background: rgba(239, 68, 68, 0.22);
      color: #F87171;
      border: 1px solid rgba(239, 68, 68, 0.5);
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.25);
    }

    .pill-notable {
      background: rgba(245, 158, 11, 0.2);
      color: #FBBF24;
      border: 1px solid rgba(245, 158, 11, 0.4);
    }

    .pill-routine {
      background: rgba(148, 163, 184, 0.1);
      color: #94A3B8;
      border: 1px solid rgba(148, 163, 184, 0.2);
    }

    .pill-urgency {
      background: rgba(99, 102, 241, 0.15);
      color: #818CF8;
      border: 1px solid rgba(99, 102, 241, 0.3);
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
    }

    .stock-stats {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 6px;
    }

    .ratio-bar-bg {
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 10px;
    }

    .ratio-bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.6s ease;
    }

    .stock-last-news {
      font-size: 11px;
      color: var(--text-sub);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* News Feed Controls */
    .controls-panel {
      background: var(--bg-card);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 16px 20px;
      margin-bottom: 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .controls-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .control-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .pill-buttons {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .control-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.18s ease;
    }

    .control-btn:hover {
      background: rgba(255, 255, 255, 0.09);
      color: #FFF;
    }

    .control-btn.active {
      background: var(--accent-indigo);
      border-color: var(--accent-indigo);
      color: #FFF;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.35);
    }

    .select-dropdown {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      color: #FFF;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      outline: none;
      cursor: pointer;
    }

    .custom-date-inputs {
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }

    .custom-date-inputs.visible {
      display: inline-flex;
    }

    .date-input {
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border-color);
      color: #FFF;
      padding: 5px 8px;
      border-radius: 6px;
      font-size: 12px;
      outline: none;
    }

    /* News Feed Cards */
    .news-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .news-card {
      background: var(--bg-card);
      backdrop-filter: blur(14px);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 20px 22px;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .news-card:hover {
      border-color: rgba(255, 255, 255, 0.18);
      background: var(--bg-card-hover);
      box-shadow: 0 10px 26px -8px rgba(0, 0, 0, 0.5);
    }

    .news-card.breaking {
      border-color: rgba(239, 68, 68, 0.35);
    }

    .news-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }

    .news-tags {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .tag-sym {
      font-family: 'Outfit', sans-serif;
      font-weight: 700;
      font-size: 14px;
      background: rgba(255, 255, 255, 0.08);
      padding: 3px 10px;
      border-radius: 6px;
      color: #FFF;
      letter-spacing: 0.5px;
    }

    .tag-conf {
      font-size: 12px;
      font-family: 'JetBrains Mono', monospace;
      color: var(--text-muted);
    }

    .tag-time {
      font-size: 12px;
      color: var(--text-sub);
    }

    .news-title {
      font-family: 'Outfit', sans-serif;
      font-size: 17px;
      font-weight: 600;
      color: #F8FAFC;
      line-height: 1.45;
      text-decoration: none;
    }

    .news-title:hover {
      color: var(--accent-cyan);
      text-decoration: underline;
    }

    .news-summary {
      font-size: 14px;
      color: #94A3B8;
      line-height: 1.6;
    }

    .news-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 4px;
      font-size: 12px;
      color: var(--text-sub);
      flex-wrap: wrap;
      gap: 8px;
    }

    .audio-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(6, 182, 212, 0.1);
      border: 1px solid rgba(6, 182, 212, 0.25);
      color: #22D3EE;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .audio-btn:hover {
      background: rgba(6, 182, 212, 0.22);
      border-color: #22D3EE;
      color: #FFF;
    }

    .audio-btn.playing {
      background: rgba(16, 185, 129, 0.18);
      border-color: #10B981;
      color: #34D399;
    }

    .equalizer-wave {
      display: inline-flex;
      align-items: flex-end;
      gap: 2px;
      height: 12px;
    }

    .eq-bar {
      width: 2px;
      background: #34D399;
      border-radius: 1px;
      animation: eqBounce 0.8s infinite ease-in-out;
    }

    .eq-bar:nth-child(1) { height: 4px; animation-delay: 0.1s; }
    .eq-bar:nth-child(2) { height: 10px; animation-delay: 0.3s; }
    .eq-bar:nth-child(3) { height: 6px; animation-delay: 0.2s; }

    @keyframes eqBounce {
      0%, 100% { transform: scaleY(0.4); }
      50% { transform: scaleY(1.2); }
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      background: var(--bg-card);
      border-radius: 14px;
      border: 1px dashed var(--border-color);
    }

    /* Price Card Row */
    .stock-price-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      margin: 8px 0 4px;
      padding: 6px 10px;
      background: rgba(0, 0, 0, 0.28);
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.04);
    }

    .stock-price {
      font-family: 'JetBrains Mono', monospace;
      font-size: 15px;
      font-weight: 700;
      color: #F8FAFC;
    }

    .stock-price-change {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .stock-price-change.pos {
      color: #34D399;
      background: rgba(16, 185, 129, 0.12);
    }

    .stock-price-change.neg {
      color: #F87171;
      background: rgba(239, 68, 68, 0.12);
    }

    .btn-symbol-chart {
      width: 100%;
      margin-top: 8px;
      padding: 6px 10px;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.25);
      color: #A5B4FC;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.2s;
    }

    .btn-symbol-chart:hover {
      background: rgba(99, 102, 241, 0.25);
      color: #FFF;
      border-color: #818CF8;
    }

    /* Symbol Detail View */
    .symbol-view-container {
      display: flex;
      flex-direction: column;
      gap: 24px;
      animation: fadeIn 0.3s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .symbol-nav-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: -6px;
    }

    .btn-back-radar {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--border-color);
      color: #E2E8F0;
      padding: 8px 16px;
      border-radius: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .btn-back-radar:hover {
      background: rgba(99, 102, 241, 0.2);
      border-color: #818CF8;
      color: #FFF;
    }

    .symbol-hero-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 20px;
      box-shadow: 0 16px 36px -12px rgba(0, 0, 0, 0.6);
    }

    .symbol-hero-left {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .symbol-avatar {
      width: 58px;
      height: 58px;
      border-radius: 14px;
      background: linear-gradient(135deg, #1E1B4B 0%, #312E81 100%);
      border: 1px solid rgba(129, 140, 248, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      font-weight: 800;
      color: #C7D2FE;
      font-family: 'Outfit', sans-serif;
    }

    .symbol-title-box h2 {
      font-family: 'Outfit', sans-serif;
      font-size: 28px;
      font-weight: 800;
      color: #FFF;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .symbol-company-title {
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .symbol-hero-right {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }

    .symbol-price-large {
      font-family: 'JetBrains Mono', monospace;
      font-size: 34px;
      font-weight: 800;
      color: #FFF;
      letter-spacing: -0.5px;
    }

    .symbol-pill-huge {
      font-family: 'JetBrains Mono', monospace;
      font-size: 13px;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 8px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .symbol-pill-huge.pos {
      color: #34D399;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .symbol-pill-huge.neg {
      color: #F87171;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }

    .symbol-stats-banner {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
    }

    .stat-tile {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 12px 14px;
    }

    .stat-tile-label {
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text-sub);
      letter-spacing: 0.5px;
      font-weight: 600;
    }

    .stat-tile-val {
      font-family: 'JetBrains Mono', monospace;
      font-size: 16px;
      font-weight: 700;
      color: #F1F5F9;
      margin-top: 4px;
    }

    /* Price Chart Card with Published News Dots */
    .chart-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 20px 24px 24px;
      position: relative;
      box-shadow: 0 16px 36px -12px rgba(0, 0, 0, 0.6);
    }

    .chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
    }

    .chart-title-group {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .chart-legend {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--text-muted);
      flex-wrap: wrap;
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .legend-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
    }

    .range-buttons {
      display: inline-flex;
      background: rgba(0, 0, 0, 0.35);
      border-radius: 8px;
      padding: 3px;
      border: 1px solid var(--border-color);
    }

    .range-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .range-btn:hover {
      color: #FFF;
    }

    .range-btn.active {
      background: #6366F1;
      color: #FFF;
      box-shadow: 0 2px 6px rgba(99, 102, 241, 0.4);
    }

    .chart-canvas-wrap {
      width: 100%;
      height: 380px;
      position: relative;
    }

    #priceChartContainer {
      width: 100%;
      height: 100%;
      position: relative;
      z-index: 0;
    }

    .chart-empty-state {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #64748B;
      font-size: 14px;
      pointer-events: none;
    }

    .news-dot-layer {
      position: absolute;
      inset: 0;
      z-index: 3;
      pointer-events: none;
      overflow: hidden;
    }

    .news-dot {
      position: absolute;
      width: 13px;
      height: 13px;
      margin: -6.5px 0 0 -6.5px;
      border-radius: 50%;
      border: 2px solid #FFFFFF;
      cursor: pointer;
      pointer-events: auto;
      box-shadow: 0 0 8px rgba(0, 0, 0, 0.55);
      transition: transform 0.15s ease;
    }

    .news-dot:hover {
      transform: scale(1.35);
    }

    .news-dot.bullish {
      background: #10B981;
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.8);
    }

    .news-dot.bearish {
      background: #F43F5E;
      box-shadow: 0 0 10px rgba(244, 63, 94, 0.8);
    }

    .news-dot.breaking {
      box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.35), 0 0 14px rgba(239, 68, 68, 0.9);
    }

    .news-dot.catalyst {
      box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.30), 0 0 10px rgba(245, 158, 11, 0.7);
    }

    .chart-dot-tooltip {
      position: absolute;
      display: none;
      z-index: 200;
      background: rgba(8, 11, 17, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.14);
      backdrop-filter: blur(16px);
      border-radius: 12px;
      padding: 12px 16px;
      color: #FFF;
      font-size: 12px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(99,102,241,0.15);
      pointer-events: none;
      width: 300px;
      line-height: 1.5;
      /* default: appear above and centred on dot */
      transform: translate(-50%, calc(-100% - 14px));
      transition: opacity 0.12s ease;
    }

    .card-highlight-flash {
      animation: flashGlow 2.5s ease;
    }

    @keyframes flashGlow {
      0% { box-shadow: 0 0 0 2px #6366F1, 0 0 24px rgba(99, 102, 241, 0.8); }
      100% { box-shadow: none; }
    }

    @media (max-width: 900px) {
      .header { flex-direction: column; align-items: flex-start; }
      .stocks-grid { grid-template-columns: 1fr 1fr; }
      .top-news-grid { grid-template-columns: 1fr; }
      .symbol-hero-card { flex-direction: column; align-items: flex-start; }
      .symbol-hero-right { align-items: flex-start; }
    }

    /* News Pagination */
    .news-pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 20px 0 8px;
      flex-wrap: wrap;
    }

    .page-btn {
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: #A5B4FC;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      font-family: 'Inter', sans-serif;
    }

    .page-btn:hover:not(:disabled) {
      background: rgba(99, 102, 241, 0.28);
      color: #FFF;
      border-color: #818CF8;
    }

    .page-btn:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }

    .page-info {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--text-muted);
      padding: 0 6px;
    }

    .page-dots {
      display: flex;
      gap: 4px;
      align-items: center;
    }

    .page-num {
      background: transparent;
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      width: 30px;
      height: 30px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.18s;
      font-family: 'Inter', sans-serif;
    }

    .page-num:hover {
      border-color: rgba(99, 102, 241, 0.5);
      color: #FFF;
    }

    .page-num.active {
      background: #6366F1;
      border-color: #6366F1;
      color: #FFF;
      box-shadow: 0 2px 8px rgba(99, 102, 241, 0.45);
    }
  </style>
  <script src="/vendor/lightweight-charts.js"></script>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand">
        <div class="brand-icon">📈</div>
        <div>
          <h1>Zero Market Radar</h1>
          <p>System 1 AI Financial Terminal powered by TypeSafe Jev, ElevenLabs & Render</p>
        </div>
      </div>
      <div class="header-actions">
        <div class="status-badges">
          <div class="badge badge-live">
            <div class="pulse-dot"></div>
            Live Radar Active
          </div>
          <div class="badge">Finnhub Paced (30/m)</div>
          <div class="badge">TypeSafe Jev: Sub-Second</div>
          <div class="badge">Shared Mongo: OK</div>
        </div>
        <button id="refreshBtn" class="btn-refresh" onclick="triggerManualRefresh()">
          <span>🔄</span>
          <span id="refreshLabel">Refresh</span>
        </button>
      </div>
    </header>

    <!-- View 1: Main Radar Dashboard -->
    <div id="radarDashboardView">
      <!-- Multi-Select Interest Symbols Panel -->
      <div class="interest-panel" id="interestPanel">
        <div class="interest-top-bar">
          <div class="section-title" style="font-size: 16px;">
            <span>🎯 Watched Interest Symbols</span>
            <span class="counter-badge" id="interestCountBadge">27 / 27 Selected</span>
          </div>
          <div class="preset-pills">
            <button class="preset-btn" onclick="selectPreset('all')">Select All</button>
            <button class="preset-btn" onclick="selectPreset('tech')">🚀 Mega Tech</button>
            <button class="preset-btn" onclick="selectPreset('semis')">⚡ Semis</button>
            <button class="preset-btn" onclick="selectPreset('china')">🇨🇳 China/HK</button>
            <button class="preset-btn" onclick="selectPreset('ev')">🚗 EV & Auto</button>
            <button class="preset-btn" onclick="selectPreset('clear')">🧹 Clear</button>
            <input type="text" class="interest-search" id="tickerSearch" placeholder="Find ticker..." oninput="filterTickerChips(this.value)">
          </div>
        </div>
        <div class="ticker-chips-grid" id="tickerChipsContainer">
          <!-- Rendered via JS -->
        </div>
      </div>

      <!-- Spotlight Section: Top News on Interest Symbols -->
      <div id="topNewsSection" style="margin-bottom: 36px;">
        <div class="section-header">
          <div class="section-title">
            <span>🔥 Top Impact News on Watched Symbols</span>
            <span class="section-subtitle">(Ranked by Market-Moving Materiality & Urgency)</span>
          </div>
          <span class="counter-badge" id="spotlightCountBadge">Top 4 Headlines</span>
        </div>
        <div class="top-news-grid" id="topNewsGrid">
          <div class="empty-state">Loading high-impact news on selected symbols...</div>
        </div>
      </div>

      <!-- Watched Stocks Sentiment Overview -->
      <div class="section-header">
        <div class="section-title">
          <span>📊 Top Watched Equities</span>
          <span class="section-subtitle">(Ranked by Bullish Ratio & Volume)</span>
        </div>
        <div class="control-group">
          <label style="font-size: 12px; color: var(--text-muted); display: inline-flex; align-items: center; gap: 6px; cursor: pointer;">
            <input type="checkbox" id="filterStocksByInterestCheckbox" checked onchange="toggleFilterStocksByInterest(this.checked)">
            Show Only My Interest Symbols
          </label>
        </div>
      </div>
      <div class="stocks-grid" id="stocksGrid">
        <div class="stock-card"><p style="color:#64748B;">Loading watchlist telemetry...</p></div>
      </div>

      <!-- Breaking News Feed & Filters -->
      <div class="section-header" style="margin-top: 40px;">
        <div class="section-title">
          <span>📰 Real-Time News Signals</span>
        </div>
      </div>

      <div class="controls-panel">
        <!-- Row 1: Date Range Filter & Order By -->
        <div class="controls-row">
          <div class="control-group">
            <span class="control-label">📅 Date Range:</span>
            <div class="pill-buttons" id="datePresetPills">
              <button class="control-btn active" data-days="3" onclick="setDateRangePreset(3, this)">3D (Default)</button>
              <button class="control-btn" data-days="1" onclick="setDateRangePreset(1, this)">24H</button>
              <button class="control-btn" data-days="7" onclick="setDateRangePreset(7, this)">7D</button>
              <button class="control-btn" data-days="30" onclick="setDateRangePreset(30, this)">30D</button>
              <button class="control-btn" data-days="365" onclick="setDateRangePreset(365, this)">1Y (All)</button>
              <button class="control-btn" onclick="toggleCustomDatePicker(this)">Custom</button>
            </div>
            <div class="custom-date-inputs" id="customDateInputs">
              <input type="date" class="date-input" id="fromDateInput">
              <span style="color:var(--text-sub);">to</span>
              <input type="date" class="date-input" id="toDateInput">
              <button class="preset-btn" onclick="applyCustomDateRange()">Apply</button>
            </div>
          </div>

          <div class="control-group">
            <span class="control-label">⚡ Order By:</span>
            <select class="select-dropdown" id="sortSelect" onchange="onSortChange(this.value)">
              <option value="impact">💥 Highest Impact (Urgency Score)</option>
              <option value="date">🕒 Latest First (Newest)</option>
              <option value="confidence">🎯 Highest Confidence</option>
            </select>
          </div>
        </div>

        <!-- Row 2: Signal Classification & Specific Ticker -->
        <div class="controls-row">
          <div class="control-group">
            <span class="control-label">🎯 Signal:</span>
            <div class="pill-buttons">
              <button class="control-btn active" onclick="setSentimentFilter('all', this)">All Signals</button>
              <button class="control-btn" onclick="setSentimentFilter('breaking', this)">🔥 Breaking Only</button>
              <button class="control-btn" onclick="setSentimentFilter('catalyst', this)">⚡ Catalysts</button>
              <button class="control-btn" onclick="setSentimentFilter('1', this)">🟢 Bullish</button>
              <button class="control-btn" onclick="setSentimentFilter('0', this)">🔴 Bearish</button>
            </div>
          </div>

          <div class="control-group">
            <span class="control-label">🔍 Ticker:</span>
            <select class="select-dropdown" id="singleSymbolSelect" onchange="onSingleSymbolChange(this.value)">
              <option value="">All Interest Symbols</option>
              ${defaultWatchlist.map((s) => `<option value="${s}">${s}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>

      <!-- News Articles List -->
      <div class="news-list" id="newsList">
        <div class="empty-state">Polling live breaking news...</div>
      </div>
      <nav class="news-pagination" aria-label="News feed pagination">
        <button class="page-btn" id="newsPrev" onclick="changeNewsPage(-1)" disabled>← Previous</button>
        <span class="page-info" id="newsPageInfo" role="status" aria-live="polite">Page 1</span>
        <button class="page-btn" id="newsNext" onclick="changeNewsPage(1)" disabled>Next →</button>
      </nav>
    </div>

    <!-- View 2: Dedicated Symbol Detail Page (Price Chart + Published News Dots + Filterable News) -->
    <div id="symbolDetailView" class="symbol-view-container" style="display: none;">
      <!-- Navigation Bar -->
      <div class="symbol-nav-bar">
        <button class="btn-back-radar" onclick="navigateToRadar()">
          <span>←</span> Back to Radar Dashboard
        </button>
        <div class="status-badges">
          <div class="badge badge-live">
            <div class="pulse-dot"></div>
            Live Chart Sync
          </div>
          <div class="badge" id="symbolLastUpdatedBadge">Live Telemetry</div>
        </div>
      </div>

      <!-- Hero Card: Price & Summary -->
      <div class="symbol-hero-card" id="symbolHeroCard">
        <div class="symbol-hero-left">
          <div class="symbol-avatar" id="heroSymbolAvatar">--</div>
          <div class="symbol-title-box">
            <h2 id="heroSymbolTitle">--</h2>
            <div class="symbol-company-title" id="heroCompanyTitle">Market Asset Telemetry</div>
          </div>
        </div>
        <div class="symbol-hero-right">
          <div class="symbol-price-large" id="heroSymbolPrice">$--</div>
          <div class="symbol-pill-huge pos" id="heroSymbolChange">+0.00 (+0.00%)</div>
        </div>
      </div>

      <!-- Stats Banner -->
      <div class="symbol-stats-banner">
        <div class="stat-tile">
          <div class="stat-tile-label">Day High</div>
          <div class="stat-tile-val" id="statHigh">$--</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-label">Day Low</div>
          <div class="stat-tile-val" id="statLow">$--</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-label">Open</div>
          <div class="stat-tile-val" id="statOpen">$--</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-label">Prev Close</div>
          <div class="stat-tile-val" id="statPrevClose">$--</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-label">Total News</div>
          <div class="stat-tile-val" id="statNewsCount">--</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-label">Bullish Ratio</div>
          <div class="stat-tile-val" id="statBullRatio">--%</div>
        </div>
      </div>

      <!-- Interactive Price Chart with News Event Dots -->
      <div class="chart-card">
        <div class="chart-header">
          <div class="chart-title-group">
            <div class="section-title" style="font-size: 17px;">
              <span>📈 Price Chart & Published News Dots</span>
            </div>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-dot" style="background:#6366F1;"></span> Price Line</span>
              <span class="legend-item"> 🟢 Bullish News</span>
              <span class="legend-item"> 🔴 Bearish News</span>
              <span class="legend-item"> 🔥 Breaking Halo</span>
            </div>
          </div>
          <div class="range-buttons" id="chartRangeButtons">
            <button class="range-btn" data-range="24h" onclick="setChartRange('24h', this)">24H</button>
            <button class="range-btn active" data-range="7d" onclick="setChartRange('7d', this)">7D</button>
            <button class="range-btn" data-range="30d" onclick="setChartRange('30d', this)">30D</button>
            <button class="range-btn" data-range="90d" onclick="setChartRange('90d', this)">90D</button>
            <button class="range-btn" data-range="1y" onclick="setChartRange('1y', this)">1Y</button>
          </div>
        </div>

        <!-- Filter Controls above chart canvas (also drive dot visibility) -->
        <div class="controls-panel" style="margin-bottom: 12px;">
          <div class="controls-row">
            <div class="control-group">
              <span class="control-label">🎯 Filter Dots &amp; News:</span>
              <div class="pill-buttons" id="symbolNewsFilterPills">
                <button class="control-btn active" onclick="setSymbolNewsFilter('all', this)">All</button>
                <button class="control-btn" onclick="setSymbolNewsFilter('breaking', this)">🔥 Breaking</button>
                <button class="control-btn" onclick="setSymbolNewsFilter('catalyst', this)">⚡ Catalysts</button>
                <button class="control-btn" onclick="setSymbolNewsFilter('bullish', this)">🟢 Bullish</button>
                <button class="control-btn" onclick="setSymbolNewsFilter('bearish', this)">🔴 Bearish</button>
              </div>
            </div>
            <div class="control-group">
              <span class="control-label">⚡ Sort:</span>
              <select class="select-dropdown" id="symbolNewsSortSelect" onchange="onSymbolNewsSortChange(this.value)">
                <option value="date">🕒 Latest First</option>
                <option value="impact">💥 Highest Urgency</option>
                <option value="confidence">🎯 Highest Confidence</option>
              </select>
              <input type="text" class="interest-search" id="symbolNewsSearchInput" placeholder="Search headline..." oninput="onSymbolNewsSearch(this.value)" style="margin-left: 8px;">
            </div>
          </div>
        </div>

        <div class="chart-canvas-wrap" id="chartCanvasWrap">
          <div id="priceChartContainer"></div>
          <div class="news-dot-layer" id="newsDotLayer"></div>
          <div id="chartDotTooltip" class="chart-dot-tooltip"></div>
        </div>
      </div>

      <!-- Filterable Symbol News Section -->
      <div>
        <div class="section-header" style="margin-top: 16px;">
          <div class="section-title">
            <span id="symbolNewsHeading">📰 Published News &amp; Catalysts</span>
            <span class="section-subtitle">(Click any dot on chart to jump)</span>
          </div>
          <span class="counter-badge" id="symbolNewsCountBadge">0 Articles</span>
        </div>

        <div class="news-list" id="symbolNewsList">
          <div class="empty-state">Loading published news for this symbol...</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const ALL_SYMBOLS = ${watchlistJson};
    const STORAGE_KEY = 'zero_market_radar_interest_symbols';
    
    // Curated Presets
    const PRESETS = {
      tech: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META'],
      semis: ['NVDA', 'AMD', 'TSM', 'AVGO', 'ARM', 'QCOM'],
      china: ['BABA', 'TCEHY', 'BYDDY', 'BIDU', 'JD', 'PDD'],
      ev: ['TSLA', 'BYDDY', 'NIO', 'LI', 'UBER'],
    };

    // State
    let interestSymbols = loadInterestSymbols();
    let currentSentiment = 'all';
    let singleSymbolFilter = '';
    let currentSortBy = 'impact'; // Order by impact by default!
    let filterStocksOnlyInterest = true;

    // Date Range: Default 3 days to today
    let dateRangeDays = 3;
    let customFromDate = '';
    let customToDate = '';

    let isAutoRefreshing = true;
    let refreshCountdown = 4;
    let refreshIntervalTimer = null;
    let currentPlayingAudio = null;

    function loadInterestSymbols() {
      try {
        const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('zero_market_sentinel_interest_symbols') || localStorage.getItem('stock_news_interest_symbols');
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map(s => String(s).toUpperCase());
          }
        }
      } catch (e) {
        console.warn('Failed to read interest symbols from localStorage:', e);
      }
      // Default: top 6 leaders if no store
      return ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL'];
    }

    function saveInterestSymbols() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(interestSymbols));
      } catch (e) {
        console.warn('Failed to write interest symbols to localStorage:', e);
      }
      updateInterestUI();
      fetchTopStocks();
      fetchTopNews();
      fetchNews();
    }

    function toggleInterestSymbol(sym) {
      const upper = sym.toUpperCase();
      const idx = interestSymbols.indexOf(upper);
      if (idx >= 0) {
        interestSymbols.splice(idx, 1);
      } else {
        interestSymbols.push(upper);
      }
      saveInterestSymbols();
    }

    function selectPreset(preset) {
      if (preset === 'all') {
        interestSymbols = [...ALL_SYMBOLS];
      } else if (preset === 'clear') {
        interestSymbols = [];
      } else if (PRESETS[preset]) {
        interestSymbols = [...PRESETS[preset]];
      }
      saveInterestSymbols();
    }

    function filterTickerChips(search) {
      const q = (search || '').trim().toUpperCase();
      document.querySelectorAll('.ticker-chip').forEach(chip => {
        const sym = chip.dataset.symbol;
        if (!q || sym.includes(q)) {
          chip.style.display = 'inline-flex';
        } else {
          chip.style.display = 'none';
        }
      });
    }

    function updateInterestUI() {
      const container = document.getElementById('tickerChipsContainer');
      const badge = document.getElementById('interestCountBadge');
      badge.textContent = \`\${interestSymbols.length} / \${ALL_SYMBOLS.length} Selected\`;

      container.innerHTML = ALL_SYMBOLS.map(sym => {
        const active = interestSymbols.includes(sym);
        return \`
          <button class="ticker-chip \${active ? 'active' : ''}" data-symbol="\${sym}" onclick="toggleInterestSymbol('\${sym}')">
            \${active ? '<span class="check-icon">✓</span>' : ''}
            <span>\${sym}</span>
          </button>
        \`;
      }).join('');
    }

    function getDateParams() {
      if (customFromDate && customToDate) {
        return { fromDate: customFromDate, toDate: customToDate };
      }
      if (dateRangeDays > 0) {
        const now = new Date();
        const past = new Date(now.getTime() - dateRangeDays * 24 * 60 * 60 * 1000);
        return {
          fromDate: past.toISOString().split('T')[0],
          toDate: now.toISOString().split('T')[0],
        };
      }
      return {};
    }

    function setDateRangePreset(days, btn) {
      dateRangeDays = days;
      customFromDate = '';
      customToDate = '';
      document.getElementById('customDateInputs').classList.remove('visible');
      document.querySelectorAll('#datePresetPills .control-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      fetchTopNews();
      fetchNews();
    }

    function toggleCustomDatePicker(btn) {
      const panel = document.getElementById('customDateInputs');
      const isVisible = panel.classList.toggle('visible');
      if (isVisible) {
        document.querySelectorAll('#datePresetPills .control-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const now = new Date();
        const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
        document.getElementById('fromDateInput').value = threeDaysAgo.toISOString().split('T')[0];
        document.getElementById('toDateInput').value = now.toISOString().split('T')[0];
      }
    }

    function applyCustomDateRange() {
      const from = document.getElementById('fromDateInput').value;
      const to = document.getElementById('toDateInput').value;
      if (!from || !to) {
        alert('Please choose both start and end dates.');
        return;
      }
      customFromDate = from;
      customToDate = to;
      dateRangeDays = 0;
      fetchTopNews();
      fetchNews();
    }

    function onSortChange(sort) {
      currentSortBy = sort;
      fetchNews();
    }

    function setSentimentFilter(filter, btn) {
      currentSentiment = filter;
      document.querySelectorAll('.controls-panel .pill-buttons .control-btn').forEach(b => {
        if (b.parentElement === btn.parentElement) b.classList.remove('active');
      });
      btn.classList.add('active');
      fetchNews();
    }

    function onSingleSymbolChange(sym) {
      singleSymbolFilter = sym;
      fetchNews();
    }

    function toggleFilterStocksByInterest(checked) {
      filterStocksOnlyInterest = checked;
      fetchTopStocks();
    }

    // Top Stocks
    async function fetchTopStocks() {
      try {
        let url = '/api/stocks';
        if (filterStocksOnlyInterest && interestSymbols.length > 0) {
          url += '?symbols=' + encodeURIComponent(interestSymbols.join(','));
        }
        const res = await fetch(url);
        const data = await res.json();
        const grid = document.getElementById('stocksGrid');
        if (!data.stocks || data.stocks.length === 0) {
          grid.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No stocks match your active interest symbols.</div>';
          return;
        }

        grid.innerHTML = data.stocks.map(s => {
          const isBull = s.bullishRatio >= 0.5;
          const pillClass = isBull ? 'pill-bullish' : 'pill-bearish';
          const pillText = isBull ? 'BULLISH' : 'BEARISH';
          const percent = Math.round(s.bullishRatio * 100);
          const confPercent = Math.round(s.avgConfidence * 100);
          const isPinned = interestSymbols.includes(s.symbol);

          const priceStr = s.price != null ? \`$\${Number(s.price).toFixed(2)}\` : '--';
          const changeVal = s.change != null ? Number(s.change) : 0;
          const pctVal = s.percentChange != null ? Number(s.percentChange) : 0;
          const isPos = changeVal >= 0;
          const changeStr = s.change != null
            ? \`\${isPos ? '+' : ''}\${changeVal.toFixed(2)} (\${isPos ? '+' : ''}\${pctVal.toFixed(2)}%)\`
            : '';

          return \`
            <div class="stock-card \${isPinned ? 'interest-active' : ''}" onclick="navigateToSymbol('\${s.symbol}')">
              <div class="stock-header">
                <div class="stock-symbol-group">
                  <span class="star-pin \${isPinned ? 'pinned' : ''}" title="\${isPinned ? 'Remove from Interest Symbols' : 'Add to Interest Symbols'}" onclick="event.stopPropagation(); toggleInterestSymbol('\${s.symbol}');">
                    ★
                  </span>
                  <span class="stock-symbol">\${s.symbol}</span>
                </div>
                <span class="stock-pill \${pillClass}">\${pillText}</span>
              </div>
              <div class="stock-price-row">
                <span class="stock-price">\${priceStr}</span>
                \${changeStr ? \`<span class="stock-price-change \${isPos ? 'pos' : 'neg'}">\${changeStr}</span>\` : ''}
              </div>
              <div class="stock-stats">
                <span>Sentiment Ratio</span>
                <span style="font-weight:600; color:#FFF;">\${percent}% Bullish</span>
              </div>
              <div class="ratio-bar-bg">
                <div class="ratio-bar-fill" style="width: \${percent}%; background: \${isBull ? 'var(--bullish-grad)' : 'var(--bearish-grad)'};"></div>
              </div>
              <div class="stock-stats" style="margin-bottom:6px;">
                <span>Avg Confidence</span>
                <span style="font-family:'JetBrains Mono';">\${confPercent}%</span>
              </div>
              <div class="stock-last-news" title="\${s.lastHeadline}">
                \${s.totalArticles} articles • \${s.lastHeadline}
              </div>
              <button class="btn-symbol-chart" onclick="event.stopPropagation(); navigateToSymbol('\${s.symbol}')">
                📈 View Symbol Chart & News →
              </button>
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Error fetching top stocks:', err);
      }
    }

    // Top News on Interest Symbols
    async function fetchTopNews() {
      try {
        const targetSymbols = interestSymbols.length > 0 ? interestSymbols : ALL_SYMBOLS;
        const dateParams = getDateParams();
        let url = '/api/top-news?limit=4&symbols=' + encodeURIComponent(targetSymbols.join(','));
        if (dateParams.fromDate) url += '&fromDate=' + encodeURIComponent(dateParams.fromDate);
        if (dateParams.toDate) url += '&toDate=' + encodeURIComponent(dateParams.toDate);

        const res = await fetch(url);
        const data = await res.json();
        const grid = document.getElementById('topNewsGrid');

        if (!data.topNews || data.topNews.length === 0) {
          grid.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">No high-impact news detected for selected symbols in this date window.</div>';
          return;
        }

        grid.innerHTML = data.topNews.map(n => {
          const isBull = n.sentiment === 1;
          const badgeClass = isBull ? 'pill-bullish' : 'pill-bearish';
          const badgeText = isBull ? 'BULLISH' : 'BEARISH';
          const urgencyPct = Math.round((n.urgencyScore ?? 0) * 100);
          const isBreaking = n.priority === 'BREAKING_CRITICAL';
          const timeStr = formatRelativeTime(n.publishedAt);

          let priorityLabel = '📄 Routine';
          if (n.priority === 'BREAKING_CRITICAL') priorityLabel = '🔥 BREAKING CRITICAL';
          else if (n.priority === 'NOTABLE_CATALYST') priorityLabel = '⚡ NOTABLE CATALYST';

          const isVoiceEligible = n.priority === 'BREAKING_CRITICAL';
          const audioButtonHtml = isVoiceEligible
            ? ('<button class="audio-btn" onclick="playVoice(' + n._id + ', this)">🎙 Listen Voice</button>')
            : '';

          return \`
            <div class="spotlight-card \${isBreaking ? 'breaking' : ''}">
              <div>
                <div class="spotlight-top">
                  <div style="display:flex; align-items:center; gap:6px;">
                    <span class="tag-sym">\${n.symbol}</span>
                    <span class="stock-pill \${badgeClass}">\${badgeText}</span>
                  </div>
                  <span class="tag-time">\${timeStr}</span>
                </div>
                <div style="margin-top:10px;">
                  <a href="\${n.url}" target="_blank" rel="noopener noreferrer" class="spotlight-title" title="\${n.headline}">
                    \${n.headline}
                  </a>
                </div>
                <div class="spotlight-summary" style="margin-top:6px;">
                  \${n.summary || 'Summary unavailable.'}
                </div>
              </div>

              <div>
                <div class="urgency-meter-wrap">
                  <div class="urgency-meter-header">
                    <span>\${priorityLabel}</span>
                    <span style="font-weight:700; color:\${isBreaking ? '#EF4444' : '#818CF8'};">\${urgencyPct}% Impact</span>
                  </div>
                  <div class="urgency-meter-bar">
                    <div class="urgency-meter-fill" style="width:\${urgencyPct}%;"></div>
                  </div>
                </div>

                <div class="news-footer" style="margin-top:12px;">
                  <span>📡 \${n.source || 'Finnhub'}</span>
                  \${audioButtonHtml}
                </div>
              </div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Error fetching top news:', err);
      }
    }

    // News Feed: server-side pagination covers the whole history, not just a cached subset.
    const NEWS_PAGE_SIZE = 10;
    let newsPage = 0;
    let newsRequest = 0;

    function changeNewsPage(direction) {
      fetchNews(Math.max(0, newsPage + direction));
      document.getElementById('newsList').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    async function fetchNews(page = 0) {
      newsPage = page;
      const request = ++newsRequest;
      try {
        const dateParams = getDateParams();
        let url = '/api/news?limit=' + NEWS_PAGE_SIZE + '&offset=' + page * NEWS_PAGE_SIZE;

        // Filter symbols
        if (singleSymbolFilter) {
          url += '&symbol=' + encodeURIComponent(singleSymbolFilter);
        } else if (interestSymbols.length > 0 && interestSymbols.length < ALL_SYMBOLS.length) {
          url += '&symbols=' + encodeURIComponent(interestSymbols.join(','));
        }

        // Sort By
        url += '&sortBy=' + encodeURIComponent(currentSortBy);

        // Date range
        if (dateParams.fromDate) url += '&fromDate=' + encodeURIComponent(dateParams.fromDate);
        if (dateParams.toDate) url += '&toDate=' + encodeURIComponent(dateParams.toDate);

        // Sentiment & Priority
        if (currentSentiment === 'breaking') {
          url += '&breaking=true';
        } else if (currentSentiment === 'catalyst') {
          url += '&priority=NOTABLE_CATALYST';
        } else if (currentSentiment !== 'all') {
          url += '&sentiment=' + encodeURIComponent(currentSentiment);
        }

        const res = await fetch(url);
        if (!res.ok) throw new Error('News request failed');
        const data = await res.json();
        if (request !== newsRequest) return;
        // Data may change during live polling; recover if the last page disappeared.
        if (data.news.length === 0 && page > 0) return fetchNews(page - 1);
        const container = document.getElementById('newsList');
        document.getElementById('newsPrev').disabled = page === 0;
        document.getElementById('newsNext').disabled = !data.hasMore;
        document.getElementById('newsPageInfo').textContent = 'Page ' + (page + 1)
          + (data.news.length ? ' · Articles ' + (page * NEWS_PAGE_SIZE + 1) + '–' + (page * NEWS_PAGE_SIZE + data.news.length) : ' · No articles');

        if (!data.news || data.news.length === 0) {
          container.innerHTML = '<div class="empty-state">No news articles match your filter criteria and date range.</div>';
          return;
        }

        container.innerHTML = data.news.map(n => {
          const isBull = n.sentiment === 1;
          const badgeClass = isBull ? 'pill-bullish' : 'pill-bearish';
          const badgeText = isBull ? '🟢 BULLISH (1)' : '🔴 BEARISH (0)';
          const conf = Math.round(n.confidence * 100);
          const bullProb = (n.probabilities.bullish * 100).toFixed(1);
          const bearProb = (n.probabilities.bearish * 100).toFixed(1);
          const timeStr = formatRelativeTime(n.publishedAt);
          const fullTime = new Date(n.publishedAt).toLocaleString();

          let priorityPill = '<span class="stock-pill pill-routine">📄 ROUTINE</span>';
          if (n.priority === 'BREAKING_CRITICAL') {
            priorityPill = '<span class="stock-pill pill-breaking">🔥 BREAKING</span>';
          } else if (n.priority === 'NOTABLE_CATALYST') {
            priorityPill = '<span class="stock-pill pill-notable">⚡ NOTABLE</span>';
          }

          const urgencyPct = Math.round((n.urgencyScore ?? 0) * 100);
          const isVoiceEligible = n.priority === 'BREAKING_CRITICAL';
          const audioButtonHtml = isVoiceEligible
            ? ('<button class="audio-btn" onclick="playVoice(' + n._id + ', this)">🎙 Listen with ElevenLabs</button>')
            : '';

          return \`
            <div class="news-card \${n.priority === 'BREAKING_CRITICAL' ? 'breaking' : ''}">
              <div class="news-card-header">
                <div class="news-tags">
                  <span class="tag-sym" onclick="filterBySingleSymbol('\${n.symbol}')" style="cursor:pointer;" title="Filter by \${n.symbol}">\${n.symbol}</span>
                  \${priorityPill}
                  <span class="stock-pill pill-urgency">⚡ \${urgencyPct}% Impact</span>
                  <span class="stock-pill \${badgeClass}">\${badgeText}</span>
                  <span class="tag-conf">Confidence: <b>\${conf}%</b> (Bull: \${bullProb}% | Bear: \${bearProb}%)</span>
                </div>
                <span class="tag-time" title="\${fullTime}">\${timeStr}</span>
              </div>
              <a href="\${n.url}" target="_blank" rel="noopener noreferrer" class="news-title">
                \${n.headline}
              </a>
              <div class="news-summary">\${n.summary}</div>
              <div class="news-footer">
                <span>📡 Source: <b>\${n.source || 'Finnhub'}</b> • Article ID: #\${n._id}</span>
                \${audioButtonHtml}
              </div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Error fetching news:', err);
      }
    }

    function filterBySingleSymbol(sym) {
      singleSymbolFilter = sym;
      document.getElementById('singleSymbolSelect').value = sym;
      fetchNews();
    }

    // Dedicated Symbol Detail View Logic
    const INITIAL_SYMBOL = ${initialSymbolJson};
    let activeSymbol = INITIAL_SYMBOL ? INITIAL_SYMBOL.toUpperCase() : '';
    let currentChartRange = '7d';
    let currentSymbolData = null;
    let symbolNewsFilter = 'all';
    let symbolNewsSort = 'date';
    let symbolNewsSearch = '';
    const SYMBOL_NEWS_PAGE_SIZE = 10;
    let symbolNewsPage = 0; // 0-indexed current page

    function navigateToSymbol(sym, push = true) {
      if (!sym) return;
      activeSymbol = sym.toUpperCase();
      document.getElementById('radarDashboardView').style.display = 'none';
      document.getElementById('symbolDetailView').style.display = 'flex';
      window.scrollTo({ top: 0, behavior: 'smooth' });
      document.title = \`\${activeSymbol} | Price Chart & News | Zero Market Radar\`;
      if (push) {
        history.pushState({ symbol: activeSymbol }, '', '/symbol/' + activeSymbol);
      }
      loadSymbolData(activeSymbol, currentChartRange);
    }

    function navigateToRadar(push = true) {
      activeSymbol = '';
      document.getElementById('symbolDetailView').style.display = 'none';
      document.getElementById('radarDashboardView').style.display = 'block';
      document.title = 'Zero Market Radar | System 1 AI Financial Terminal';
      if (push) {
        history.pushState({}, '', '/');
      }
    }

    window.addEventListener('popstate', (e) => {
      if (e.state && e.state.symbol) {
        navigateToSymbol(e.state.symbol, false);
      } else {
        const path = window.location.pathname;
        if (path.startsWith('/symbol/')) {
          const sym = path.replace('/symbol/', '').trim().toUpperCase();
          if (sym) {
            navigateToSymbol(sym, false);
            return;
          }
        }
        navigateToRadar(false);
      }
    });

    async function loadSymbolData(symbol, range = '7d') {
      try {
        const badge = document.getElementById('symbolLastUpdatedBadge');
        if (badge) badge.textContent = 'Syncing...';

        const res = await fetch(\`/api/chart/\${encodeURIComponent(symbol)}?range=\${encodeURIComponent(range)}\`);
        const data = await res.json();
        currentSymbolData = data;

        if (badge) badge.textContent = !data.candles?.length ? 'Price history unavailable'
          : (data.priceHistory?.stale ? 'Stale prices • ' : 'Prices as of • ')
            + new Date(data.priceHistory?.fetchedAt ?? Date.now()).toLocaleString();

        renderSymbolHero(data);
        renderPriceChart(data);
        filterAndRenderSymbolNews();
      } catch (err) {
        console.error('Failed to load symbol data:', err);
      }
    }

    function setChartRange(range, btn) {
      currentChartRange = range;
      document.querySelectorAll('#chartRangeButtons .range-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      if (activeSymbol) {
        loadSymbolData(activeSymbol, range);
      }
    }

    function renderSymbolHero(data) {
      const sym = data.symbol;
      const quote = data.quote;
      const news = data.news || [];

      document.getElementById('heroSymbolAvatar').textContent = sym.slice(0, 4);
      document.getElementById('heroSymbolTitle').innerHTML = \`
        \${sym}
        <span class="stock-pill pill-routine" style="font-size:12px; vertical-align:middle;">US Equity</span>
      \`;
      document.getElementById('heroCompanyTitle').textContent = \`Real-Time System 1 Telemetry • \${news.length} Published Articles Synced\`;

      const price = quote && quote.price != null ? Number(quote.price) : (data.candles && data.candles.length ? data.candles[data.candles.length - 1].close : null);
      const change = quote && quote.change != null ? Number(quote.change) : 0;
      const pct = quote && quote.percentChange != null ? Number(quote.percentChange) : 0;
      const isPos = change >= 0;

      const priceEl = document.getElementById('heroSymbolPrice');
      const changeEl = document.getElementById('heroSymbolChange');

      priceEl.textContent = price != null ? \`$\${price.toFixed(2)}\` : '--';
      changeEl.className = \`symbol-pill-huge \${isPos ? 'pos' : 'neg'}\`;
      changeEl.textContent = \`\${isPos ? '+' : ''}\${change.toFixed(2)} (\${isPos ? '+' : ''}\${pct.toFixed(2)}%)\`;

      document.getElementById('statHigh').textContent = quote && quote.high != null ? \`$\${Number(quote.high).toFixed(2)}\` : '--';
      document.getElementById('statLow').textContent = quote && quote.low != null ? \`$\${Number(quote.low).toFixed(2)}\` : '--';
      document.getElementById('statOpen').textContent = quote && quote.open != null ? \`$\${Number(quote.open).toFixed(2)}\` : '--';
      document.getElementById('statPrevClose').textContent = quote && quote.previousClose != null ? \`$\${Number(quote.previousClose).toFixed(2)}\` : '--';
      document.getElementById('statNewsCount').textContent = \`\${news.length}\`;

      const bullCount = news.filter(n => n.sentiment === 1).length;
      const bullRatio = news.length > 0 ? Math.round((bullCount / news.length) * 100) : 50;
      const ratioEl = document.getElementById('statBullRatio');
      ratioEl.textContent = \`\${bullRatio}%\`;
      ratioEl.style.color = bullRatio >= 50 ? '#10B981' : '#F43F5E';
    }

    // Price chart powered by TradingView Lightweight Charts (vendored via /vendor/lightweight-charts.js)
    let priceChart = null;
    let priceSeries = null;
    let chartCandles = [];
    let newsDots = [];
    let hoveredNewsId = null;

    function initPriceChart() {
      if (priceChart || typeof LightweightCharts === 'undefined') return false;
      const container = document.getElementById('priceChartContainer');
      if (!container) return false;
      // The hovered element may be replaced during refresh without a mouseleave event.
      const wrap = document.getElementById('chartCanvasWrap');
      wrap.addEventListener('pointermove', event => {
        if (!event.target.closest('.news-dot')) hideNewsDotTooltip();
      });
      wrap.addEventListener('pointerleave', () => hideNewsDotTooltip());

      priceChart = LightweightCharts.createChart(container, {
        layout: {
          background: { color: 'transparent' },
          textColor: '#9CA3AF',
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        },
        grid: {
          vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
          horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
        },
        rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
        timeScale: {
          borderColor: 'rgba(255, 255, 255, 0.08)',
          time: { format: 'yyyy-MM-dd HH:mm' },
        },
        crosshair: {
          vertLine: { color: 'rgba(99, 102, 241, 0.5)', labelBackgroundColor: '#6366F1' },
          horzLine: { color: 'rgba(99, 102, 241, 0.5)', labelBackgroundColor: '#6366F1' },
        },
        handleScale: false,
        handleScroll: false,
      });

      priceSeries = priceChart.addSeries(LightweightCharts.LineSeries, {
        color: '#6366F1',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });

      // Reposition news dots whenever the visible time range changes (scroll/zoom)
      priceChart.timeScale().subscribeVisibleLogicalRangeChange(() => positionNewsDots());

      new ResizeObserver(() => {
        priceChart && priceChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
        requestAnimationFrame(positionNewsDots);
      }).observe(container);

      return true;
    }

    function renderPriceChart(data) {
      const container = document.getElementById('priceChartContainer');
      const dotLayer = document.getElementById('newsDotLayer');
      if (!container || !dotLayer) return;

      // Clear stale dots before setData/fitContent can trigger chart callbacks.
      newsDots = [];
      dotLayer.innerHTML = '';
      hideNewsDotTooltip(false);
      chartCandles = [...new Map((data.candles || [])
        .filter(c => Number.isFinite(c.close) && Number.isFinite(c.timestamp))
        .map(c => [Math.floor(c.timestamp / 1000), { ...c, timestamp: Math.floor(c.timestamp / 1000) * 1000 }])).values()]
        .sort((a, b) => a.timestamp - b.timestamp);
      const news = (data.news || []).filter(n =>
        n.priority === 'BREAKING_CRITICAL' || n.priority === 'NOTABLE_CATALYST');

      // initPriceChart() returns false only when the library is missing or the
      // container is absent; an already-created chart is a no-op, not an error.
      if (!priceChart && !initPriceChart()) {
        dotLayer.innerHTML = '<div class="chart-empty-state">Chart library unavailable — price history not rendered.</div>';
        return;
      }

      if (chartCandles.length === 0) {
        priceSeries.setData([]);
        hideNewsDotTooltip();
        dotLayer.innerHTML = '<div class="chart-empty-state">No historical price candles available for this asset & range.</div>';
        return;
      }

      priceChart.applyOptions({
        width: container.clientWidth,
        height: container.clientHeight,
        timeScale: {
          time: {
            format: currentChartRange === '24h' || currentChartRange === '1d'
              ? 'HH:mm'
              : 'yyyy-MM-dd',
          },
        },
      });

      priceSeries.setData(chartCandles.map(c => ({
        time: Math.floor(c.timestamp / 1000),
        value: c.close,
      })));
      priceChart.timeScale().fitContent();

      // Build news event dots as positioned HTML overlays
      news.forEach(n => {
        const tMs = new Date(n.publishedAt).getTime();
        if (!Number.isFinite(tMs)) return;
        // Markets close; news does not. Anchor weekend/after-hours events to the
        // nearest available price without changing their true publication timestamp.
        const anchorMs = Math.max(chartCandles[0].timestamp,
          Math.min(chartCandles[chartCandles.length - 1].timestamp, tMs));
        const nextIndex = chartCandles.findIndex(c => c.timestamp >= anchorMs);
        const leftIndex = Math.max(0, nextIndex - 1);
        const rightIndex = nextIndex;
        const left = chartCandles[leftIndex];
        const right = chartCandles[rightIndex];
        const ratio = leftIndex === rightIndex ? 0 : (anchorMs - left.timestamp) / (right.timestamp - left.timestamp);
        const el = document.createElement('div');
        el.className = 'news-dot ' + (n.sentiment === 1 ? 'bullish' : 'bearish')
          + (n.priority === 'BREAKING_CRITICAL' ? ' breaking' : n.priority === 'NOTABLE_CATALYST' ? ' catalyst' : '');
        el.title = n.headline;
        el.dataset.priority = n.priority || '';
        el.dataset.sentiment = String(n.sentiment);
        if (anchorMs !== tMs) el.dataset.priceAnchor = new Date(anchorMs).toISOString();

        el.addEventListener('mouseenter', () => showNewsDotTooltip(el, n));
        el.addEventListener('mouseleave', hideNewsDotTooltip);
        el.addEventListener('click', () => jumpToNewsArticle(n._id));

        dotLayer.appendChild(el);
        el.dataset.price = String(left.close + ratio * (right.close - left.close));
        newsDots.push({ el, leftIndex, rightIndex, ratio, news: n });
      });

      // Position immediately too: requestAnimationFrame is paused in hidden tabs.
      positionNewsDots();
      // Reposition once the chart has finished its layout pass.
      requestAnimationFrame(() => {
        positionNewsDots();
        updateChartDotVisibility();
      });
    }

    function positionNewsDots() {
      if (!priceChart || !priceSeries) return;
      const timeScale = priceChart.timeScale();

      newsDots.forEach(dot => {
        // timeToCoordinate only resolves actual bars. Interpolate screen coordinates
        // between those bars so intrabar/weekend events stay on the rendered line.
        const left = chartCandles[dot.leftIndex];
        const right = chartCandles[dot.rightIndex];
        const x1 = timeScale.timeToCoordinate(left.timestamp / 1000);
        const x2 = timeScale.timeToCoordinate(right.timestamp / 1000);
        const y1 = priceSeries.priceToCoordinate(left.close);
        const y2 = priceSeries.priceToCoordinate(right.close);
        const x = x1 == null || x2 == null ? null : x1 + dot.ratio * (x2 - x1);
        const y = y1 == null || y2 == null ? null : y1 + dot.ratio * (y2 - y1);
        // Store out-of-range flag; visibility filtering is handled by updateChartDotVisibility()
        dot.outOfRange = (x == null || y == null);
        if (!dot.outOfRange) {
          dot.el.style.left = x + 'px';
          dot.el.style.top = y + 'px';
        }
      });
      // Re-apply visibility so display is consistent
      updateChartDotVisibility();
    }

    // Show/hide dots on the chart according to the active symbolNewsFilter and position validity
    function updateChartDotVisibility() {
      newsDots.forEach(dot => {
        const n = dot.news;
        if (dot.outOfRange) {
          dot.el.style.display = 'none';
          return;
        }
        let visible = true;
        if (symbolNewsFilter === 'breaking') {
          visible = n.priority === 'BREAKING_CRITICAL';
        } else if (symbolNewsFilter === 'catalyst') {
          visible = n.priority === 'NOTABLE_CATALYST';
        } else if (symbolNewsFilter === 'bullish') {
          visible = n.sentiment === 1;
        } else if (symbolNewsFilter === 'bearish') {
          visible = n.sentiment === 0;
        }
        if (symbolNewsSearch) {
          visible = visible && (
            (n.headline && n.headline.toLowerCase().includes(symbolNewsSearch)) ||
            (n.summary && n.summary.toLowerCase().includes(symbolNewsSearch))
          );
        }
        dot.el.style.display = visible ? 'block' : 'none';
      });
      // Recreated dots must retain the active tooltip during the four-second refresh.
      if (hoveredNewsId != null) {
        const hovered = newsDots.find(dot => dot.news._id === hoveredNewsId && dot.el.style.display !== 'none');
        if (hovered) showNewsDotTooltip(hovered.el, hovered.news);
        else hideNewsDotTooltip();
      }
    }

    function showNewsDotTooltip(el, n) {
      const tooltip = document.getElementById('chartDotTooltip');
      const wrap = document.getElementById('chartCanvasWrap');
      if (!tooltip || !wrap) return;
      hoveredNewsId = n._id;

      const isBull = n.sentiment === 1;
      const sentColor = isBull ? '#34D399' : '#F87171';
      const sentEmoji = isBull ? '🟢' : '🔴';
      const sentLabel = isBull ? 'Bullish' : 'Bearish';
      const impact = Math.round((n.urgencyScore || 0) * 100);
      const conf = Math.round((n.confidence || 0) * 100);
      const price = n._price != null ? '$' + Number(n._price).toFixed(2) : (el.dataset.price ? '$' + Number(el.dataset.price).toFixed(2) : null);
      const timeStr = new Date(n.publishedAt).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });

      let priorityColor = '#6B7280';
      let priorityLabel = '📄 Routine';
      if (n.priority === 'BREAKING_CRITICAL') { priorityColor = '#EF4444'; priorityLabel = '🔥 Breaking Critical'; }
      else if (n.priority === 'NOTABLE_CATALYST') { priorityColor = '#F59E0B'; priorityLabel = '⚡ Notable Catalyst'; }

      const bullPct = n.probabilities ? (n.probabilities.bullish * 100).toFixed(0) : '--';
      const bearPct = n.probabilities ? (n.probabilities.bearish * 100).toFixed(0) : '--';

      tooltip.innerHTML = \`
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; gap:8px;">
          <span style="font-size:10px; font-weight:700; color:\${priorityColor}; letter-spacing:0.3px; text-transform:uppercase;">\${priorityLabel}</span>
          <span style="font-size:10px; color:#94A3B8;">\${timeStr}</span>
        </div>
        <div style="font-weight:600; font-size:13px; color:#F8FAFC; line-height:1.4; margin-bottom:10px;">\${n.headline}</div>
        \${el.dataset.priceAnchor ? '<div style="font-size:10px; color:#94A3B8; margin-bottom:8px;">Outside price history · anchored to price bar at ' + new Date(el.dataset.priceAnchor).toLocaleString() + '</div>' : ''}
        <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:10px;">
          <div style="background:rgba(255,255,255,0.04); border-radius:7px; padding:5px 8px; text-align:center;">
            <div style="font-size:9px; color:#64748B; text-transform:uppercase; letter-spacing:0.3px;">Signal</div>
            <div style="font-size:12px; font-weight:700; color:\${sentColor}; margin-top:1px;">\${sentEmoji} \${sentLabel}</div>
          </div>
          <div style="background:rgba(255,255,255,0.04); border-radius:7px; padding:5px 8px; text-align:center;">
            <div style="font-size:9px; color:#64748B; text-transform:uppercase; letter-spacing:0.3px;">Confidence</div>
            <div style="font-size:12px; font-weight:700; color:#A5B4FC; margin-top:1px;">\${conf}%</div>
          </div>
          <div style="background:rgba(255,255,255,0.04); border-radius:7px; padding:5px 8px; text-align:center;">
            <div style="font-size:9px; color:#64748B; text-transform:uppercase; letter-spacing:0.3px;">Impact</div>
            <div style="font-size:12px; font-weight:700; color:#F59E0B; margin-top:1px;">⚡ \${impact}%</div>
          </div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:10px; color:#64748B; border-top:1px solid rgba(255,255,255,0.06); padding-top:7px;">
          <span>🐂 \${bullPct}% bull &nbsp;·&nbsp; 🐻 \${bearPct}% bear</span>
          <span style="color:#818CF8; font-weight:600; font-size:11px;">Click to jump ↓</span>
        </div>
      \`;

      // Smart positioning: place above dot, flip sides if near an edge
      const dotX = parseFloat(el.style.left) || 0;
      const dotY = parseFloat(el.style.top) || 0;
      const tooltipW = 300;
      const wrapW = wrap.clientWidth;

      // Centre by default, clamp so it doesn't overflow left/right
      let left = Math.max(tooltipW / 2, Math.min(wrapW - tooltipW / 2, dotX));
      tooltip.style.left = left + 'px';
      tooltip.style.top = dotY + 'px';

      // If too close to top, flip below the dot instead
      if (dotY < 80) {
        tooltip.style.transform = 'translate(-50%, 14px)';
      } else {
        tooltip.style.transform = 'translate(-50%, calc(-100% - 14px))';
      }

      tooltip.style.display = 'block';
    }

    function hideNewsDotTooltip(resetHover = true) {
      if (resetHover) hoveredNewsId = null;
      const tooltip = document.getElementById('chartDotTooltip');
      if (tooltip) tooltip.style.display = 'none';
    }

    function jumpToNewsArticle(articleId) {
      // Find which page the article lives on (respecting current filter/sort)
      if (!currentSymbolData || !currentSymbolData.news) return;

      let news = [...currentSymbolData.news];
      if (symbolNewsFilter === 'breaking') news = news.filter(n => n.priority === 'BREAKING_CRITICAL');
      else if (symbolNewsFilter === 'catalyst') news = news.filter(n => n.priority === 'NOTABLE_CATALYST');
      else if (symbolNewsFilter === 'bullish') news = news.filter(n => n.sentiment === 1);
      else if (symbolNewsFilter === 'bearish') news = news.filter(n => n.sentiment === 0);
      if (symbolNewsSearch) {
        news = news.filter(n =>
          (n.headline && n.headline.toLowerCase().includes(symbolNewsSearch)) ||
          (n.summary && n.summary.toLowerCase().includes(symbolNewsSearch))
        );
      }
      if (symbolNewsSort === 'impact') news.sort((a, b) => (b.urgencyScore || 0) - (a.urgencyScore || 0));
      else if (symbolNewsSort === 'confidence') news.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      else news.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

      const idx = news.findIndex(n => n._id === articleId);
      if (idx === -1) {
        // Article not visible under current filter — reset filter to 'all' and retry
        setSymbolNewsFilter('all', document.querySelector('#symbolNewsFilterPills .control-btn'));
        return;
      }

      const targetPage = Math.floor(idx / SYMBOL_NEWS_PAGE_SIZE);
      if (targetPage !== symbolNewsPage) {
        symbolNewsPage = targetPage;
        filterAndRenderSymbolNews();
      }

      // Slight delay to let the DOM update before scrolling
      setTimeout(() => {
        const articleEl = document.getElementById('symbol-news-' + articleId);
        if (articleEl) {
          articleEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          articleEl.classList.remove('card-highlight-flash');
          void articleEl.offsetWidth;
          articleEl.classList.add('card-highlight-flash');
        }
      }, 80);
    }

    function setSymbolNewsFilter(filter, btn) {
      symbolNewsFilter = filter;
      symbolNewsPage = 0;
      document.querySelectorAll('#symbolNewsFilterPills .control-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      filterAndRenderSymbolNews();
      updateChartDotVisibility();
    }

    function onSymbolNewsSortChange(sort) {
      symbolNewsSort = sort;
      symbolNewsPage = 0;
      filterAndRenderSymbolNews();
    }

    function onSymbolNewsSearch(val) {
      symbolNewsSearch = (val || '').trim().toLowerCase();
      symbolNewsPage = 0;
      filterAndRenderSymbolNews();
      updateChartDotVisibility();
    }

    function filterAndRenderSymbolNews() {
      if (!currentSymbolData || !currentSymbolData.news) return;

      let news = [...currentSymbolData.news];

      if (symbolNewsFilter === 'breaking') {
        news = news.filter(n => n.priority === 'BREAKING_CRITICAL');
      } else if (symbolNewsFilter === 'catalyst') {
        news = news.filter(n => n.priority === 'NOTABLE_CATALYST');
      } else if (symbolNewsFilter === 'bullish') {
        news = news.filter(n => n.sentiment === 1);
      } else if (symbolNewsFilter === 'bearish') {
        news = news.filter(n => n.sentiment === 0);
      }

      if (symbolNewsSearch) {
        news = news.filter(n =>
          (n.headline && n.headline.toLowerCase().includes(symbolNewsSearch)) ||
          (n.summary && n.summary.toLowerCase().includes(symbolNewsSearch))
        );
      }

      if (symbolNewsSort === 'impact') {
        news.sort((a, b) => (b.urgencyScore || 0) - (a.urgencyScore || 0));
      } else if (symbolNewsSort === 'confidence') {
        news.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      } else {
        news.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      }

      const totalCount = news.length;
      const totalPages = Math.max(1, Math.ceil(totalCount / SYMBOL_NEWS_PAGE_SIZE));
      symbolNewsPage = Math.min(symbolNewsPage, totalPages - 1);
      const pageStart = symbolNewsPage * SYMBOL_NEWS_PAGE_SIZE;
      const pageNews = news.slice(pageStart, pageStart + SYMBOL_NEWS_PAGE_SIZE);

      const container = document.getElementById('symbolNewsList');
      const badge = document.getElementById('symbolNewsCountBadge');
      const heading = document.getElementById('symbolNewsHeading');

      heading.textContent = \`📰 Published News & Catalysts for \${activeSymbol}\`;
      badge.textContent = \`\${totalCount} Articles\`;

      if (totalCount === 0) {
        container.innerHTML = '<div class="empty-state">No published news articles match your filter criteria.</div>';
        return;
      }

      const cards = pageNews.map(n => {
        const isBull = n.sentiment === 1;
        const badgeClass = isBull ? 'pill-bullish' : 'pill-bearish';
        const badgeText = isBull ? '🟢 BULLISH (1)' : '🔴 BEARISH (0)';
        const conf = Math.round(n.confidence * 100);
        const bullProb = (n.probabilities.bullish * 100).toFixed(1);
        const bearProb = (n.probabilities.bearish * 100).toFixed(1);
        const timeStr = formatRelativeTime(n.publishedAt);
        const fullTime = new Date(n.publishedAt).toLocaleString();

        let priorityPill = '<span class="stock-pill pill-routine">📄 ROUTINE</span>';
        if (n.priority === 'BREAKING_CRITICAL') {
          priorityPill = '<span class="stock-pill pill-breaking">🔥 BREAKING</span>';
        } else if (n.priority === 'NOTABLE_CATALYST') {
          priorityPill = '<span class="stock-pill pill-notable">⚡ NOTABLE</span>';
        }

        const urgencyPct = Math.round((n.urgencyScore ?? 0) * 100);
        const isVoiceEligible = n.priority === 'BREAKING_CRITICAL';
        const audioButtonHtml = isVoiceEligible
          ? ('<button class="audio-btn" onclick="playVoice(' + n._id + ', this)">🎙 Listen with ElevenLabs</button>')
          : '';

        return \`
          <div class="news-card \${n.priority === 'BREAKING_CRITICAL' ? 'breaking' : ''}" id="symbol-news-\${n._id}">
            <div class="news-card-header">
              <div class="news-tags">
                <span class="tag-sym">\${n.symbol}</span>
                \${priorityPill}
                <span class="stock-pill pill-urgency">⚡ \${urgencyPct}% Impact</span>
                <span class="stock-pill \${badgeClass}">\${badgeText}</span>
                <span class="tag-conf">Confidence: <b>\${conf}%</b> (Bull: \${bullProb}% | Bear: \${bearProb}%)</span>
              </div>
              <span class="tag-time" title="\${fullTime}">🕒 \${timeStr}</span>
            </div>
            <a href="\${n.url}" target="_blank" rel="noopener noreferrer" class="news-title">
              \${n.headline}
            </a>
            <div class="news-summary">\${n.summary}</div>
            <div class="news-footer">
              <span>📡 Source: <b>\${n.source || 'Finnhub'}</b> • Article ID: #\${n._id}</span>
              \${audioButtonHtml}
            </div>
          </div>
        \`;
      }).join('');

      // Pagination bar
      const from = pageStart + 1;
      const to = Math.min(pageStart + SYMBOL_NEWS_PAGE_SIZE, totalCount);
      const pagination = totalPages > 1 ? \`
        <div class="news-pagination">
          <button class="page-btn" onclick="goNewsPage(\${symbolNewsPage - 1})" \${symbolNewsPage === 0 ? 'disabled' : ''}>← Prev</button>
          <span class="page-info">\${from}–\${to} of \${totalCount}</span>
          <span class="page-dots">
            \${Array.from({ length: totalPages }, (_, i) => \`
              <button class="page-num \${i === symbolNewsPage ? 'active' : ''}" onclick="goNewsPage(\${i})">\${i + 1}</button>
            \`).join('')}
          </span>
          <button class="page-btn" onclick="goNewsPage(\${symbolNewsPage + 1})" \${symbolNewsPage >= totalPages - 1 ? 'disabled' : ''}>Next →</button>
        </div>
      \` : '';

      container.innerHTML = cards + pagination;
    }

    function goNewsPage(page) {
      const totalCount = (currentSymbolData && currentSymbolData.news) ? currentSymbolData.news.length : 0;
      const totalPages = Math.max(1, Math.ceil(totalCount / SYMBOL_NEWS_PAGE_SIZE));
      symbolNewsPage = Math.max(0, Math.min(page, totalPages - 1));
      filterAndRenderSymbolNews();
      document.getElementById('symbolNewsList').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    window.addEventListener('resize', () => {
      if (activeSymbol && currentSymbolData) {
        renderPriceChart(currentSymbolData);
      }
    });

    function formatRelativeTime(iso) {
      const diffMs = Date.now() - new Date(iso).getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return \`\${mins}m ago\`;
      const hours = Math.floor(mins / 60);
      if (hours < 24) return \`\${hours}h ago\`;
      const days = Math.floor(hours / 24);
      return \`\${days}d ago\`;
    }

    function playVoice(articleId, btn) {
      if (currentPlayingAudio) {
        currentPlayingAudio.pause();
        currentPlayingAudio = null;
        document.querySelectorAll('.audio-btn').forEach(b => {
          b.classList.remove('playing');
          b.innerHTML = '🎙 Listen with ElevenLabs';
        });
      }

      const origText = btn.innerHTML;
      btn.innerHTML = '⏳ Synthesizing...';
      btn.disabled = true;

      const audio = new Audio('/api/audio/' + articleId);
      currentPlayingAudio = audio;

      audio.onplay = () => {
        btn.classList.add('playing');
        btn.innerHTML = \`
          <span class="equalizer-wave">
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
          </span>
          <span>Playing Audio</span>
        \`;
        btn.disabled = false;
      };

      audio.onended = () => {
        btn.classList.remove('playing');
        btn.innerHTML = origText;
        btn.disabled = false;
        currentPlayingAudio = null;
      };

      audio.onerror = () => {
        alert('Voice synthesis unavailable. Please ensure ELEVENLABS_API_KEY is configured in your deployment.');
        btn.classList.remove('playing');
        btn.innerHTML = origText;
        btn.disabled = false;
        currentPlayingAudio = null;
      };

      audio.play().catch(e => {
        console.warn('Audio play failed:', e);
        btn.classList.remove('playing');
        btn.innerHTML = origText;
        btn.disabled = false;
      });
    }

    function triggerManualRefresh() {
      fetchTopStocks();
      fetchTopNews();
      fetchNews(newsPage);
      if (activeSymbol) {
        loadSymbolData(activeSymbol, currentChartRange);
      }
      const label = document.getElementById('refreshLabel');
      label.textContent = 'Updated!';
      setTimeout(() => { label.textContent = 'Refresh'; }, 1000);
    }

    // Init
    updateInterestUI();
    fetchTopStocks();
    fetchTopNews();
    fetchNews();

    if (INITIAL_SYMBOL) {
      navigateToSymbol(INITIAL_SYMBOL, false);
    } else {
      const p = window.location.pathname;
      if (p.startsWith('/symbol/')) {
        const sym = p.replace('/symbol/', '').trim().toUpperCase();
        if (sym) {
          navigateToSymbol(sym, false);
        }
      }
    }

    // Auto-refresh poll every 4 seconds
    setInterval(() => {
      fetchTopStocks();
      fetchTopNews();
      fetchNews(newsPage);
      if (activeSymbol) {
        loadSymbolData(activeSymbol, currentChartRange);
      }
    }, 4000);
  </script>
</body>
</html>`;
}
