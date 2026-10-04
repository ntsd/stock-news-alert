import http from 'node:http';
import type { NewsAlertPoller } from '../scheduler/poller.js';
import type { PredictionStorageService } from '../services/mongodb.js';
import type { ElevenLabsService } from '../services/elevenlabs.js';

export interface WebServerOptions {
  port: number;
  watchlist: string[];
  poller: NewsAlertPoller;
  storage: PredictionStorageService;
  elevenlabsService: ElevenLabsService;
}

export function createWebServer(options: WebServerOptions): http.Server {
  const { port, watchlist, poller, storage, elevenlabsService } = options;

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
      // 1. Health check endpoint (for Render Blueprint zero-downtime health monitoring)
      if (url.pathname === '/health') {
        const stats = poller.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(
          JSON.stringify(
            {
              status: stats.isRunning ? 'healthy' : 'stopped',
              service: 'stock-news-alert',
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

      // 3. Top Stocks Watching endpoint (ordered by bullish ratio & volume)
      if (url.pathname === '/api/stocks') {
        const stocks = await storage.getTopStocks(watchlist);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ stocks }));
        return;
      }

      // 4. News feed endpoint (with filter by symbol, sentiment, priority, and breaking)
      if (url.pathname === '/api/news') {
        const symbol = url.searchParams.get('symbol') || undefined;
        const sentimentParam = url.searchParams.get('sentiment');
        const sentiment = sentimentParam !== null ? (Number.parseInt(sentimentParam, 10) as 1 | 0) : undefined;
        const priorityParam = url.searchParams.get('priority') as 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE' | null;
        const priority = priorityParam || undefined;
        const breakingOnly = url.searchParams.get('breaking') === 'true';
        const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10);

        const news = await storage.getRecentNews(limit, symbol, sentiment, priority, breakingOnly);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ news }));
        return;
      }

      // 5. ElevenLabs Audio Stream endpoint on-demand (with MongoDB audio cache)
      if (url.pathname.startsWith('/api/audio/')) {
        const articleId = Number.parseInt(url.pathname.replace('/api/audio/', ''), 10);
        const article = await storage.getCachedPrediction(articleId);

        if (!article) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Article not found' }));
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

      // 6. Web Dashboard UI
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboardHtml(watchlist));
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
    console.log(`🌐 [Web] Stock News Alert Dashboard & API active at http://localhost:${port}`);
  });

  return server;
}

function renderDashboardHtml(defaultWatchlist: string[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stock News Alert | System 1 AI Financial Sentinel</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #080B11;
      --bg-surface: #0E131F;
      --bg-card: rgba(18, 24, 38, 0.75);
      --bg-card-hover: rgba(26, 34, 52, 0.85);
      --border-color: rgba(255, 255, 255, 0.08);
      --border-glow: rgba(99, 102, 241, 0.25);
      
      --text-main: #F3F4F6;
      --text-muted: #9CA3AF;
      --text-sub: #6B7280;

      --bullish-grad: linear-gradient(135deg, #10B981 0%, #059669 100%);
      --bullish-color: #10B981;
      --bullish-glow: rgba(16, 185, 129, 0.2);

      --bearish-grad: linear-gradient(135deg, #F43F5E 0%, #BE123C 100%);
      --bearish-color: #F43F5E;
      --bearish-glow: rgba(244, 63, 94, 0.2);

      --accent-indigo: #6366F1;
      --accent-cyan: #06B6D4;
      --accent-grad: linear-gradient(135deg, #6366F1 0%, #06B6D4 100%);
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
        radial-gradient(circle at 15% 15%, rgba(99, 102, 241, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 85% 25%, rgba(6, 182, 212, 0.06) 0%, transparent 45%);
    }

    .container {
      max-width: 1380px;
      margin: 0 auto;
      padding: 24px 20px 60px;
    }

    /* Header Bar */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 24px;
      border-bottom: 1px solid var(--border-color);
      margin-bottom: 32px;
      flex-wrap: wrap;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .brand-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: var(--accent-grad);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      box-shadow: 0 4px 16px rgba(99, 102, 241, 0.35);
    }

    .brand h1 {
      font-family: 'Outfit', sans-serif;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.5px;
      background: linear-gradient(135deg, #FFFFFF 30%, #CBD5E1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .brand p {
      font-size: 13px;
      color: var(--text-muted);
    }

    .status-badges {
      display: flex;
      align-items: center;
      gap: 10px;
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
      border-color: rgba(16, 185, 129, 0.3);
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
      50% { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(0.95); opacity: 0.8; }
    }

    /* Section Headers */
    .section-title {
      font-family: 'Outfit', sans-serif;
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .section-title span {
      font-size: 13px;
      color: var(--text-muted);
      font-weight: 400;
    }

    /* Top Stocks Grid */
    .stocks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 36px;
    }

    .stock-card {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border-color);
      border-radius: 14px;
      padding: 16px;
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }

    .stock-card:hover {
      background: var(--bg-card-hover);
      border-color: rgba(255, 255, 255, 0.18);
      transform: translateY(-2px);
      box-shadow: 0 10px 24px -10px rgba(0, 0, 0, 0.5);
    }

    .stock-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .stock-symbol {
      font-family: 'Outfit', sans-serif;
      font-size: 20px;
      font-weight: 700;
      color: #FFF;
      letter-spacing: 0.5px;
    }

    .stock-pill {
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .pill-bullish {
      background: rgba(16, 185, 129, 0.15);
      color: #34D399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .pill-bearish {
      background: rgba(244, 63, 94, 0.15);
      color: #FB7185;
      border: 1px solid rgba(244, 63, 94, 0.3);
    }

    .pill-breaking {
      background: rgba(239, 68, 68, 0.2);
      color: #F87171;
      border: 1px solid rgba(239, 68, 68, 0.45);
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
      margin-bottom: 8px;
    }

    .ratio-bar-bg {
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 12px;
    }

    .ratio-bar-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--bullish-grad);
      transition: width 0.6s ease;
    }

    .stock-last-news {
      font-size: 11px;
      color: var(--text-sub);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Main News Feed Layout */
    .feed-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .filter-tabs {
      display: flex;
      gap: 8px;
    }

    .tab-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
      padding: 7px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .tab-btn:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #FFF;
    }

    .tab-btn.active {
      background: var(--accent-indigo);
      border-color: var(--accent-indigo);
      color: #FFF;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }

    .symbol-select {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      color: #FFF;
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 13px;
      outline: none;
      cursor: pointer;
    }

    .news-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

    .news-card {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 20px;
      transition: all 0.2s ease;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .news-card:hover {
      border-color: rgba(255, 255, 255, 0.16);
      background: var(--bg-card-hover);
    }

    .news-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .news-tags {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tag-sym {
      font-family: 'Outfit', sans-serif;
      font-weight: 700;
      font-size: 14px;
      background: rgba(255, 255, 255, 0.06);
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
      line-height: 1.4;
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
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .audio-btn:hover {
      background: rgba(6, 182, 212, 0.2);
    }

    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      background: var(--bg-card);
      border-radius: 12px;
      border: 1px dashed var(--border-color);
    }

    @media (max-width: 768px) {
      .header { flex-direction: column; align-items: flex-start; }
      .stocks-grid { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="brand">
        <div class="brand-icon">📈</div>
        <div>
          <h1>Stock News Alert</h1>
          <p>System 1 AI Financial Sentinel powered by TypeSafe Jev, ElevenLabs & Render</p>
        </div>
      </div>
      <div class="status-badges">
        <div class="badge badge-live">
          <div class="pulse-dot"></div>
          Live Polling Active
        </div>
        <div class="badge">Finnhub Free Cap: 60/m</div>
        <div class="badge">TypeSafe Jev: Sub-Second</div>
        <div class="badge">Shared Mongo Cache: OK</div>
      </div>
    </header>

    <!-- Top Stocks Section -->
    <div class="section-title">
      <h3>🔥 Top Watched Equities <span>(Ranked by Bullish Sentiment & Volume)</span></h3>
    </div>
    <div class="stocks-grid" id="stocksGrid">
      <!-- Injected via JavaScript -->
      <div class="stock-card"><p style="color:#64748B;">Loading watchlist telemetry...</p></div>
    </div>

    <!-- Feed Controls -->
    <div class="section-title" style="margin-top: 36px;">
      <h3>⚡ Real-Time Breaking Signals</h3>
      <div class="feed-controls">
        <div class="filter-tabs">
          <button class="tab-btn active" onclick="setSentimentFilter('all')">All Signals</button>
          <button class="tab-btn" onclick="setSentimentFilter('breaking')">🔥 Breaking Only</button>
          <button class="tab-btn" onclick="setSentimentFilter('catalyst')">⚡ Catalysts</button>
          <button class="tab-btn" onclick="setSentimentFilter('1')">🟢 Bullish</button>
          <button class="tab-btn" onclick="setSentimentFilter('0')">🔴 Bearish</button>
        </div>
        <select class="symbol-select" id="symbolSelect" onchange="onSymbolChange(this.value)">
          <option value="">All Tickers</option>
          ${defaultWatchlist.map((s) => `<option value="${s}">${s}</option>`).join('')}
        </select>
      </div>
    </div>

    <!-- News List -->
    <div class="news-list" id="newsList">
      <div class="empty-state">Polling live breaking news...</div>
    </div>
  </div>

  <script>
    let currentSentiment = 'all';
    let currentSymbol = '';

    async function fetchTopStocks() {
      try {
        const res = await fetch('/api/stocks');
        const data = await res.json();
        const grid = document.getElementById('stocksGrid');
        if (!data.stocks || data.stocks.length === 0) return;

        grid.innerHTML = data.stocks.map(s => {
          const isBull = s.bullishRatio >= 0.5;
          const pillClass = isBull ? 'pill-bullish' : 'pill-bearish';
          const pillText = isBull ? 'BULLISH' : 'BEARISH';
          const percent = Math.round(s.bullishRatio * 100);
          const confPercent = Math.round(s.avgConfidence * 100);

          return \`
            <div class="stock-card" onclick="filterBySymbol('\${s.symbol}')">
              <div class="stock-header">
                <span class="stock-symbol">\${s.symbol}</span>
                <span class="stock-pill \${pillClass}">\${pillText}</span>
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
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Error fetching top stocks:', err);
      }
    }

    async function fetchNews() {
      try {
        let url = '/api/news?limit=30';
        if (currentSymbol) url += '&symbol=' + encodeURIComponent(currentSymbol);
        if (currentSentiment === 'breaking') {
          url += '&breaking=true';
        } else if (currentSentiment === 'catalyst') {
          url += '&priority=NOTABLE_CATALYST';
        } else if (currentSentiment !== 'all') {
          url += '&sentiment=' + encodeURIComponent(currentSentiment);
        }

        const res = await fetch(url);
        const data = await res.json();
        const container = document.getElementById('newsList');

        if (!data.news || data.news.length === 0) {
          container.innerHTML = '<div class="empty-state">No breaking articles found for the selected criteria.</div>';
          return;
        }

        container.innerHTML = data.news.map(n => {
          const isBull = n.sentiment === 1;
          const badgeClass = isBull ? 'pill-bullish' : 'pill-bearish';
          const badgeText = isBull ? '🟢 BULLISH (1)' : '🔴 BEARISH (0)';
          const conf = Math.round(n.confidence * 100);
          const bullProb = (n.probabilities.bullish * 100).toFixed(1);
          const bearProb = (n.probabilities.bearish * 100).toFixed(1);
          const timeStr = new Date(n.publishedAt).toLocaleString();

          let priorityPill = '<span class="stock-pill pill-routine">📄 ROUTINE</span>';
          if (n.priority === 'BREAKING_CRITICAL') {
            priorityPill = '<span class="stock-pill pill-breaking">🔥 BREAKING</span>';
          } else if (n.priority === 'NOTABLE_CATALYST') {
            priorityPill = '<span class="stock-pill pill-notable">⚡ NOTABLE</span>';
          }

          const urgencyPct = Math.round((n.urgencyScore ?? 0) * 100);

          return \`
            <div class="news-card">
              <div class="news-card-header">
                <div class="news-tags">
                  <span class="tag-sym">\${n.symbol}</span>
                  \${priorityPill}
                  <span class="stock-pill pill-urgency">⚡ \${urgencyPct}% Urgency</span>
                  <span class="stock-pill \${badgeClass}">\${badgeText}</span>
                  <span class="tag-conf">Conf: <b>\${conf}%</b> (Bull: \${bullProb}% | Bear: \${bearProb}%)</span>
                </div>
                <span class="tag-time">\${timeStr}</span>
              </div>
              <a href="\${n.url}" target="_blank" rel="noopener noreferrer" class="news-title">
                \${n.headline}
              </a>
              <div class="news-summary">\${n.summary}</div>
              <div class="news-footer">
                <span>📡 Source: <b>\${n.source || 'Finnhub'}</b> • ID: #\${n._id}</span>
                <button class="audio-btn" onclick="playVoice(\${n._id}, this)">
                  🎙 Listen with ElevenLabs
                </button>
              </div>
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error('Error fetching news:', err);
      }
    }

    function setSentimentFilter(filter) {
      currentSentiment = filter;
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');
      fetchNews();
    }

    function onSymbolChange(sym) {
      currentSymbol = sym;
      fetchNews();
    }

    function filterBySymbol(sym) {
      currentSymbol = sym;
      document.getElementById('symbolSelect').value = sym;
      fetchNews();
    }

    function playVoice(articleId, btn) {
      const origText = btn.innerHTML;
      btn.innerHTML = '⏳ Synthesizing...';
      btn.disabled = true;

      const audio = new Audio('/api/audio/' + articleId);
      audio.onended = () => {
        btn.innerHTML = origText;
        btn.disabled = false;
      };
      audio.onerror = () => {
        alert('Voice synthesis unavailable. Please ensure ELEVENLABS_API_KEY is configured.');
        btn.innerHTML = origText;
        btn.disabled = false;
      };
      audio.play().then(() => {
        btn.innerHTML = '🔊 Playing...';
      }).catch(e => {
        console.warn('Audio play failed:', e);
        btn.innerHTML = origText;
        btn.disabled = false;
      });
    }

    // Initial load
    fetchTopStocks();
    fetchNews();

    // Auto-refresh poll every 4 seconds
    setInterval(() => {
      fetchTopStocks();
      fetchNews();
    }, 4000);
  </script>
</body>
</html>`;
}
