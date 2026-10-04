import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runInNewContext } from 'node:vm';
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

    await storage.savePrediction(
      {
        category: 'company',
        datetime: Math.floor(Date.now() / 1000) - 10000,
        headline: 'Routine Technical Commentary on TSLA',
        id: 7003,
        image: '',
        related: 'TSLA',
        source: 'Motley Fool',
        summary: 'General educational column on market volatility.',
        url: 'https://example.com/tsla',
      },
      {
        sentiment: 0,
        label: 'BEARISH',
        confidence: 0.7,
        probabilities: { bullish: 0.3, bearish: 0.7 },
        rawChoice: 'bearish',
        priority: 'ROUTINE_NOISE',
        priorityConfidence: 0.88,
        priorityProbabilities: { breaking_critical: 0.05, notable_catalyst: 0.1, routine_noise: 0.85 },
        isBreaking: false,
        urgencyScore: 0.15,
      }
    );

    const mockFinnhub: any = {
      fetchQuote: async (symbol: string) => ({
        symbol,
        price: 125.5,
        change: 3.25,
        percentChange: 2.66,
        high: 128.0,
        low: 122.0,
        open: 123.0,
        previousClose: 122.25,
        timestamp: Date.now(),
      }),
      fetchPriceHistory: async (symbol: string, range: string) => [
        { timestamp: Date.now() - 7200000, price: 121, open: 120, high: 122, low: 119, close: 121, volume: 1000 },
        { timestamp: Date.now() - 3600000, price: 124, open: 121, high: 125, low: 120, close: 124, volume: 2000 },
        { timestamp: Date.now(), price: 125.5, open: 124, high: 128, low: 123, close: 125.5, volume: 1500 },
      ],
    };

    const elevenlabs = new ElevenLabsService();
    await storage.saveQuote(await mockFinnhub.fetchQuote('NVDA'));
    server = createWebServer({
      port,
      watchlist: ['NVDA', 'AAPL', 'TSLA', 'MSFT'],
      poller: mockPoller,
      storage,
      elevenlabsService: elevenlabs,
      finnhubClient: mockFinnhub,
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
    const today = new Date().toISOString().split('T')[0];
    const res = await get(`/api/news?fromDate=${yesterday}&toDate=${today}`);
    assert.equal(res.status, 200);
    assert.ok(res.data.news.length >= 2);

    // Old date ranges are outside the public news window.
    const pastRes = await get('/api/news?fromDate=2020-01-01&toDate=2020-01-02');
    assert.equal(pastRes.status, 400);
  });

  it('paginates the full filtered news feed and identifies the last page', async () => {
    const first = await get('/api/news?sortBy=impact&limit=1&symbols=NVDA,AAPL');
    assert.equal(first.status, 200);
    assert.deepEqual(first.data.news.map((n: any) => n._id), [7001]);
    assert.equal(first.data.hasMore, true);
    const second = await get('/api/news?sortBy=impact&limit=1&offset=1&symbols=NVDA,AAPL');
    assert.deepEqual(second.data.news.map((n: any) => n._id), [7002]);
    assert.equal(second.data.hasMore, false);
    const empty = await get('/api/news?limit=1&offset=3');
    assert.deepEqual(empty.data.news, []);
    assert.equal(empty.data.hasMore, false);
  });

  it('validates seven-day news dates on both feeds, including omitted bounds', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const earliest = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    for (const endpoint of ['/api/news', '/api/top-news']) {
      assert.equal((await get(`${endpoint}?fromDate=${earliest}&toDate=${today}`)).status, 200);
      for (const query of ['fromDate=invalid', 'fromDate=2026-02-30', 'fromDate=2020-01-01',
        `toDate=${tomorrow}`, `fromDate=${today}&toDate=${earliest}`]) {
        assert.equal((await get(`${endpoint}?${query}`)).status, 400, query);
      }
    }
  });

  it('restricts custom news dates and guards invalid presets in the browser', async () => {
    const res = await get('/');
    const source = res.raw.slice(res.raw.indexOf('function getDateParams()'), res.raw.indexOf('function onSortChange'));
    const inputs: Record<string, any> = {
      fromDateInput: { value: '', checkValidity: () => true },
      toDateInput: { value: '', checkValidity: () => true },
      customDateInputs: { classList: { toggle: () => true, remove() {} } },
    };
    const context: any = {
      document: { getElementById: (id: string) => inputs[id], querySelectorAll: () => [] },
      fetchTopNews() {}, fetchNews() { context.fetches++; }, alert() { context.alerts++; }, fetches: 0, alerts: 0,
    };
    runInNewContext(`let dateRangeDays = 3, customFromDate = '', customToDate = ''; ${source}
      toggleCustomDatePicker({ classList: { add() {} } });
      applyCustomDateRange();
      setDateRangePreset(30);
      selectedDays = dateRangeDays;
      document.getElementById('fromDateInput').value = '2020-01-01';
      applyCustomDateRange();
    `, context);
    assert.equal(inputs.fromDateInput.min, new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
    assert.equal(inputs.toDateInput.max, new Date().toISOString().slice(0, 10));
    assert.equal(context.selectedDays, 0);
    assert.equal(context.fetches, 1);
    assert.equal(context.alerts, 1);
  });

  it('rejects invalid pagination arguments', async () => {
    for (const query of ['offset=-1', 'offset=abc', 'offset=1.5', 'offset=1000001', 'limit=0', 'limit=201']) {
      assert.equal((await get('/api/news?' + query)).status, 400);
    }
  });

  it('should render the dashboard HTML with interest symbol filters and impact controls', async () => {
    const res = await get('/');
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('Zero Market Radar'));
    assert.ok(res.raw.includes('Watched Interest Symbols'));
    assert.ok(res.raw.includes('Top Impact News on Watched Symbols'));
    assert.ok(res.raw.includes('Highest Impact (Urgency Score)'));
    assert.ok(res.raw.includes('3D (Default)'));
    assert.ok(res.raw.indexOf('id="dashboardFilters"') < res.raw.indexOf('id="interestPanel"'));
    const sharedFilters = res.raw.slice(res.raw.indexOf('id="dashboardFilters"'), res.raw.indexOf('id="interestPanel"'));
    assert.ok(sharedFilters.includes('id="datePresetPills"'));
    assert.ok(!sharedFilters.includes('id="sortSelect"'));
    assert.ok(!sharedFilters.includes('setSentimentFilter'));
    assert.ok(!sharedFilters.includes('id="singleSymbolSelect"'));
    assert.ok(res.raw.indexOf('id="newsFilters"') > res.raw.indexOf('📰 Real-Time News Signals'));
    assert.ok(res.raw.indexOf('id="newsFilters"') < res.raw.indexOf('id="newsList"'));
    assert.equal((res.raw.match(/id="datePresetPills"/g) || []).length, 1);
    assert.ok(!res.raw.includes('data-days="30"'));
    assert.ok(!res.raw.includes('data-days="365"'));
    assert.ok(res.raw.includes('aria-label="News feed pagination"'));
    assert.match(res.raw, /#priceChartContainer\s*\{[^}]*z-index: 0;/);
    assert.match(res.raw, /\.news-dot-layer\s*\{[^}]*z-index: 3;/);
    assert.ok(res.raw.includes('fetchNews(newsPage, true)'));
    assert.equal((res.raw.match(/const isVoiceEligible = n.priority === 'BREAKING_CRITICAL';/g) || []).length, 3);
    assert.ok(!res.raw.includes("const isVoiceEligible = n.priority === 'BREAKING_CRITICAL' ||"));
  });

  it('positions eligible chart dots between real bars and clears stale dots on empty data', async () => {
    const res = await get('/');
    const source = res.raw.slice(res.raw.indexOf('let priceChart = null;'), res.raw.indexOf('function showNewsDotTooltip'));
    const dotLayer = { innerHTML: '', appendChild() {} };
    const container = { clientWidth: 500, clientHeight: 300 };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'priceChartContainer' ? container : dotLayer,
        createElement: () => ({ style: {}, dataset: {}, addEventListener() {} }),
      },
      requestAnimationFrame: (fn: () => void) => fn(),
      tooltipIds: [],
      showNewsDotTooltip(_el: unknown, news: { _id: number }) { context.tooltipIds.push(news._id); },
      hideNewsDotTooltip() {}, symbolNewsFilter: 'all', symbolNewsSearch: '', currentChartRange: '7d',
      data: {
        // Deliberately unsorted; duplicate bars must not crash Lightweight Charts.
        candles: [{ timestamp: 2000000, close: 120 }, { timestamp: 1000000, close: 100 }, { timestamp: 2000000, close: 120 }],
        news: [
          { _id: 1, priority: 'BREAKING_CRITICAL', publishedAt: new Date(1500000).toISOString(), sentiment: 1 },
          { _id: 2, priority: 'NOTABLE_CATALYST', publishedAt: new Date(1750000).toISOString(), sentiment: 0 },
          { _id: 3, priority: 'ROUTINE_NOISE', publishedAt: new Date(1500000).toISOString() },
          { _id: 4, priority: 'BREAKING_CRITICAL', publishedAt: new Date(500000).toISOString() },
          { _id: 5, priority: 'NOTABLE_CATALYST', publishedAt: new Date(3000000).toISOString() },
        ],
      },
    };
    runInNewContext(source + `
      const times = new Map([[1000, 10], [2000, 110]]);
      priceChart = { applyOptions() {}, timeScale: () => ({
        fitContent() {}, timeToCoordinate: t => times.get(t) ?? null,
      }) };
      priceSeries = { setData() {}, priceToCoordinate: p => 300 - p };
      renderPriceChart(data);
      output = newsDots.map(d => ({id: d.news._id, x: d.el.style.left, y: d.el.style.top, display: d.el.style.display}));
      anchors = newsDots.filter(d => d.el.dataset.priceAnchor).map(d => ({id: d.news._id, anchor: d.el.dataset.priceAnchor, published: d.news.publishedAt}));
      symbolNewsFilter = 'catalyst'; updateChartDotVisibility();
      filtered = newsDots.map(d => d.el.style.display);
      hoveredNewsId = 2;
      renderPriceChart(data);
      restoredHover = hoveredNewsId;
      renderPriceChart({ candles: [], news: [] });
      remaining = newsDots.length;
    `, context);
    assert.equal(JSON.stringify(context.output), JSON.stringify([
      { id: 1, x: '60px', y: '190px', display: 'block' },
      { id: 2, x: '85px', y: '185px', display: 'block' },
      { id: 4, x: '10px', y: '200px', display: 'block' },
      { id: 5, x: '110px', y: '180px', display: 'block' },
    ]));
    assert.equal(JSON.stringify(context.filtered), JSON.stringify(['none', 'block', 'none', 'block']));
    assert.equal(context.anchors[1].anchor, new Date(2000000).toISOString());
    assert.equal(context.anchors[1].published, new Date(3000000).toISOString());
    assert.equal(context.restoredHover, 2);
    assert.ok(context.tooltipIds.length > 0);
    assert.ok(context.tooltipIds.every((id: number) => id === 2));
    assert.equal(context.remaining, 0);
  });

  it('configures real Lightweight Charts time labels and preserves them on refresh', async () => {
    const res = await get('/');
    const source = res.raw.slice(res.raw.indexOf('let priceChart = null;'), res.raw.indexOf('function showNewsDotTooltip'));
    const container = { clientWidth: 800, clientHeight: 380 };
    const context: any = {
      document: {
        getElementById: (id: string) => id === 'priceChartContainer' ? container : { addEventListener() {}, innerHTML: '' },
      },
      LightweightCharts: {
        LineSeries: {}, createChart(_container: unknown, options: unknown) {
          context.options = options;
          return {
            addSeries: () => ({ setData() {} }),
            applyOptions(options: unknown) { context.refreshed = options; },
            timeScale: () => ({ subscribeVisibleLogicalRangeChange() {}, fitContent() {} }),
          };
        },
      },
      ResizeObserver: class { observe() {} }, requestAnimationFrame(fn: () => void) { fn(); },
      hideNewsDotTooltip() {}, currentChartRange: '7d', symbolNewsFilter: 'all', symbolNewsSearch: '',
    };
    runInNewContext(source + `renderPriceChart({candles: [{timestamp: 1791207000000, close: 125}], news: []});`, context);
    assert.equal(context.options.timeScale.timeVisible, true);
    assert.equal(context.options.timeScale.secondsVisible, false);
    assert.equal(context.refreshed.timeScale.timeVisible, true);
    assert.match(context.options.localization.timeFormatter(1791207000), /13:30 UTC$/);
    assert.equal(context.options.timeScale.time, undefined);
  });

  it('rejects catalyst audio even when previously cached, but plays cached breaking audio', async () => {
    await storage.saveAudio(7002, Buffer.from('old-catalyst-audio'));
    assert.equal((await get('/api/audio/7002')).status, 403);
    await storage.saveAudio(7001, Buffer.from('breaking-audio'));
    const breaking = await get('/api/audio/7001');
    assert.equal(breaking.status, 200);
    assert.equal(breaking.raw, 'breaking-audio');
  });

  it('should reject /api/audio/:id with 403 Forbidden for ROUTINE_NOISE articles', async () => {
    const res = await get('/api/audio/7003');
    assert.equal(res.status, 403);
    assert.ok(res.data.error.includes('only available for breaking critical news'));
  });

  it('should return real-time price quote at /api/quote/:symbol', async () => {
    const res = await get('/api/quote/NVDA');
    assert.equal(res.status, 200);
    assert.ok(res.data.quote);
    assert.equal(res.data.quote.symbol, 'NVDA');
    assert.equal(res.data.quote.price, 125.5);
    assert.equal(res.data.quote.change, 3.25);
  });

  it('should return chart candles, quote, and published news at /api/chart/:symbol', async () => {
    const res = await get('/api/chart/NVDA?range=7d');
    assert.equal(res.status, 200);
    assert.equal(res.data.symbol, 'NVDA');
    assert.ok(res.data.quote);
    assert.ok(Array.isArray(res.data.candles));
    assert.equal(res.data.candles.length, 3);
    assert.ok(Array.isArray(res.data.news));
    assert.ok(res.data.news.length >= 1);
    assert.equal(res.data.news[0].symbol, 'NVDA');
    assert.equal(res.data.priceHistory.stale, false);
    assert.ok(res.data.priceHistory.fetchedAt);
    assert.equal((await storage.getPriceCandles('NVDA', '1h')).length, 3);
  });

  it('replaces watchlist loading with a retry message after telemetry failure', async () => {
    const { raw } = await get('/');
    const source = raw.slice(raw.indexOf('// Top Stocks'), raw.indexOf('// Top News on Interest Symbols'));
    for (const failure of ['http', 'network']) {
      const grid = { innerHTML: 'Loading watchlist telemetry...', querySelector: () => null };
      const context = {
        filterStocksOnlyInterest: true, interestSymbols: ['AAPL'], AbortSignal,
        console: { error() {} }, document: { getElementById: () => grid },
        fetch: async (_url: string, options: { signal: AbortSignal }) => {
          assert.ok(options.signal);
          if (failure === 'network') throw new Error('Network unavailable');
          return { ok: false, status: 500 };
        },
      };
      await runInNewContext(source + 'fetchTopStocks();', context);
      assert.match(grid.innerHTML, /temporarily unavailable/);
      assert.ok(!grid.innerHTML.includes('Loading watchlist'));
    }
  });

  it('coalesces slow equities refreshes and preserves cards when refreshing fails', async () => {
    const { raw } = await get('/');
    const source = raw.slice(raw.indexOf('// Top Stocks'), raw.indexOf('// Top News on Interest Symbols'));
    const grid = { innerHTML: 'Previously loaded cards', querySelector: () => ({}) };
    let calls = 0;
    let rejectRequest!: (error: Error) => void;
    const context = {
      filterStocksOnlyInterest: true, interestSymbols: ['AAPL'], AbortSignal,
      console: { error() {} }, document: { getElementById: () => grid },
      fetch: () => { calls++; return new Promise((_resolve, reject) => { rejectRequest = reject; }); },
    };
    const pending = runInNewContext(source + `
      const first = fetchTopStocks();
      fetchTopStocks(); fetchTopStocks();
      first;
    `, context);
    assert.equal(calls, 1);
    rejectRequest(new Error('Timeout'));
    await pending;
    assert.equal(grid.innerHTML, 'Previously loaded cards');
    const retry = runInNewContext('fetchTopStocks();', context);
    assert.equal(calls, 2);
    rejectRequest(new Error('Network failure'));
    await retry;
    assert.equal(grid.innerHTML, 'Previously loaded cards');
  });

  it('rejects unsupported chart ranges and invalid symbols', async () => {
    for (const range of ['30d', '90d', '1y']) {
      assert.equal((await get('/api/chart/NVDA?range=' + range)).status, 400);
    }
    assert.equal((await get('/api/chart/NVDA?range=max')).status, 400);
    assert.equal((await get('/api/chart/NVDA?range=invalid')).status, 400);
    assert.equal((await get('/api/chart/NVDA%2Fbad')).status, 400);
  });

  it('should render dedicated symbol page at /symbol/:symbol', async () => {
    const res = await get('/symbol/NVDA');
    assert.equal(res.status, 200);
    assert.ok(res.raw.includes('priceChartContainer'));
    assert.ok(res.raw.includes('symbolNewsList'));
    assert.ok(res.raw.includes('"NVDA"'));
    assert.ok(res.raw.includes('Back to Radar Dashboard'));
    assert.ok(!res.raw.includes('data-range="30d"'));
    assert.ok(!res.raw.includes('data-range="90d"'));
    assert.ok(!res.raw.includes('data-range="1y"'));
    assert.ok(res.raw.includes('Time: UTC'));
    assert.ok(res.raw.includes('timeVisible: true'));
    assert.ok(!res.raw.includes("time: { format:"));
  });

  it('keeps saved interests and presets within the configured watchlist', async () => {
    const { raw } = await get('/');
    const constants = raw.slice(raw.indexOf('const ALL_SYMBOLS ='), raw.indexOf('// State'));
    const load = raw.slice(raw.indexOf('function loadInterestSymbols()'), raw.indexOf('function saveInterestSymbols()'));
    const preset = raw.slice(raw.indexOf('function selectPreset('), raw.indexOf('function filterTickerChips('));
    const context: any = { localStorage: { getItem: () => '["NVDA","TCEHY","XIACY"]' } };
    runInNewContext(constants + load + preset + `
      let interestSymbols = loadInterestSymbols();
      function saveInterestSymbols() {}
      saved = interestSymbols;
      selectPreset('semis'); semis = interestSymbols;
      selectPreset('tech'); tech = interestSymbols;
    `, context);
    assert.equal(JSON.stringify(context.saved), '["NVDA"]');
    assert.equal(JSON.stringify(context.semis), '["NVDA"]');
    assert.equal(JSON.stringify(context.tech), '["AAPL","MSFT","NVDA"]');
    assert.ok(!raw.includes("selectPreset('china')"));
    assert.ok(!raw.includes('China/HK'));
    assert.ok(!raw.includes('china:'));
    for (const stored of [null, '["ORCL","XIACY"]']) {
      const fallback: any = { localStorage: { getItem: () => stored } };
      runInNewContext(constants + load + 'saved = loadInterestSymbols();', fallback);
      assert.equal(JSON.stringify(fallback.saved), '["NVDA","TSLA","AAPL","MSFT"]');
    }
    const toggle = raw.slice(raw.indexOf('function toggleInterestSymbol('), raw.indexOf('function selectPreset('));
    const toggleContext: any = {};
    runInNewContext(constants + toggle + `
      let interestSymbols = ['NVDA'];
      function saveInterestSymbols() {}
      toggleInterestSymbol('ORCL'); selected = interestSymbols;
    `, toggleContext);
    assert.equal(JSON.stringify(toggleContext.selected), '["NVDA"]');
    assert.ok(raw.includes('container.innerHTML = ALL_SYMBOLS.map(sym =>'));
    assert.ok(!raw.includes("selectPreset('ev')"));
  });

  it('links symbol badges to symbol pages in all three news card renderers', async () => {
    const { raw } = await get('/');
    const links = raw.match(/<a class="tag-sym" href="\/symbol\/\$\{encodeURIComponent\(n.symbol\)\}"/g) || [];
    assert.equal(links.length, 3);
    assert.ok(!raw.includes('<span class="tag-sym"'));
    assert.ok(!raw.includes('title="Filter by ${n.symbol}"'));
  });

  it('shares equities cache across filters and concurrent loads, serving stale data during refresh', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const cachedStorage = new PredictionStorageService();
    const original = await storage.getTopStocks(['AAPL', 'NVDA']);
    let finish!: (stocks: typeof original) => void;
    let started!: () => void;
    const loading = new Promise<void>(resolve => { started = resolve; });
    const load = t.mock.method(cachedStorage, 'getTopStocks', async () => {
      started();
      return await new Promise<typeof original>(resolve => { finish = resolve; });
    });
    const cachedServer = createWebServer({ port: 0, watchlist: ['AAPL', 'NVDA'],
      storage: cachedStorage, poller: mockPoller, elevenlabsService: new ElevenLabsService() });
    t.after(() => new Promise<void>(resolve => cachedServer.close(() => resolve())));
    await new Promise<void>(resolve => cachedServer.once('listening', resolve));
    const address = cachedServer.address() as { port: number };
    const read = async (symbols: string) => (await fetch(`http://localhost:${address.port}/api/stocks?symbols=${symbols}`)).json();
    const first = read('AAPL');
    await loading;
    const second = read('NVDA');
    finish(original);
    assert.equal((await first).stocks[0].symbol, 'AAPL');
    assert.equal((await second).stocks[0].symbol, 'NVDA');
    assert.equal(load.mock.callCount(), 1);
    assert.deepEqual(load.mock.calls[0]?.arguments, [['AAPL', 'NVDA']]);
    assert.equal((await read('ORCL')).stocks.length, 0);
    assert.equal(load.mock.callCount(), 1);

    t.mock.timers.tick(30001);
    const stale = await read('AAPL'); // Does not wait for the unresolved refresh.
    assert.equal(stale.stocks[0].totalArticles, original.find(s => s.symbol === 'AAPL')!.totalArticles);
    assert.equal(load.mock.callCount(), 2);
    await read('NVDA');
    assert.equal(load.mock.callCount(), 2);
    finish(original.map(stock => ({ ...stock, totalArticles: 999 })));
    assert.equal((await read('AAPL')).stocks[0].totalArticles, 999);

    load.mock.mockImplementation(async () => { throw new Error('Mongo temporarily unavailable'); });
    t.mock.timers.tick(30001);
    assert.equal((await read('AAPL')).stocks[0].totalArticles, 999);
    assert.equal(load.mock.callCount(), 3);
    await read('NVDA');
    assert.equal(load.mock.callCount(), 3); // Failed refresh has a five-second retry delay.
  });

  it('should include price fields in /api/stocks when quotes are available', async () => {
    const res = await get('/api/stocks?symbols=NVDA');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.stocks));
    const nvda = res.data.stocks.find((s: any) => s.symbol === 'NVDA');
    assert.ok(nvda);
    assert.equal(nvda.price, 125.5);
    assert.equal(nvda.change, 3.25);
  });

  it('shares complete homepage snapshots per symbol independent of date and page parameters', async (t) => {
    const now = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now });
    const snapshotStorage = new PredictionStorageService();
    const sample = (await storage.getRecentNews({ limit: 1 }))[0]!;
    const docs = Array.from({ length: 220 }, (_, i) => ({ ...sample, _id: 9000 + i, symbol: 'AAPL' }));
    const load = t.mock.method(snapshotStorage, 'getRecentNews', async (options: any) => {
      assert.equal(options.limit, 0);
      assert.equal(options.sortBy, 'date');
      assert.equal(options.fromDate, new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
      assert.equal(options.toDate, new Date().toISOString().slice(0, 10));
      return options.symbol === 'AAPL' ? docs : [];
    });
    const snapshotServer = createWebServer({ port: 0, watchlist: ['AAPL', 'NVDA'], storage: snapshotStorage,
      poller: mockPoller, elevenlabsService: new ElevenLabsService() });
    t.after(() => new Promise<void>(resolve => snapshotServer.close(() => resolve())));
    await new Promise<void>(resolve => snapshotServer.once('listening', resolve));
    const address = snapshotServer.address() as { port: number };
    const read = (query: string) => fetch(`http://localhost:${address.port}/api/home-news?${query}`);
    const responses = await Promise.all([
      read('symbol=AAPL'), read('symbol=aapl&fromDate=2020-01-01&offset=10&limit=1'),
    ]);
    for (const response of responses) assert.equal((await response.json()).news.length, 220);
    assert.equal(load.mock.callCount(), 1);
    assert.equal((await (await read('symbol=NVDA')).json()).news.length, 0);
    assert.equal(load.mock.callCount(), 2);
    for (const query of ['', 'symbol=ORCL', 'symbol=AAPL,NVDA']) assert.equal((await read(query)).status, 400);
    assert.equal(load.mock.callCount(), 2);
    t.mock.timers.tick(30001);
    assert.equal((await (await read('symbol=AAPL')).json()).news.length, 220);
    assert.equal(load.mock.callCount(), 3);
    // A new UTC day requires a fresh bounded snapshot rather than yesterday's cache.
    t.mock.timers.tick(86400000);
    await read('symbol=AAPL');
    assert.equal(load.mock.callCount(), 4);
  });

  it('filters and paginates cached symbols in the browser without date or page requests', async () => {
    const { raw } = await get('/');
    const source = raw.slice(raw.indexOf('// Cached snapshots are independent'), raw.indexOf('// Dedicated Symbol Detail View Logic'));
    let now = Date.parse('2026-10-05T12:00:00.000Z');
    class Clock extends Date { static override now() { return now; } }
    // The browser's UTC day uses new Date(), as well as Date.now().
    const BrowserDate = class extends Clock { constructor(value?: string | number) { super(value ?? now); } };
    const docs = Array.from({ length: 125 }, (_, i) => ({
      _id: i, symbol: 'AAPL', headline: 'Article ' + i, summary: '', source: 'Test', url: 'https://example.com',
      publishedAt: '2026-10-04T12:00:00.000Z', createdAt: '2026-10-04T12:00:00.000Z',
      sentiment: i % 2, priority: i % 2 ? 'BREAKING_CRITICAL' : 'NOTABLE_CATALYST', isBreaking: Boolean(i % 2),
      confidence: 0.9, urgencyScore: i / 125, probabilities: { bullish: 0.9, bearish: 0.1 },
    }));
    const elements = new Map<string, any>();
    let calls = 0;
    let fail = false;
    const context: any = {
      Date: BrowserDate, AbortSignal, console: { error() {}, warn() {} },
      ALL_SYMBOLS: ['AAPL', 'NVDA'], interestSymbols: ['AAPL'], singleSymbolFilter: '',
      currentSentiment: 'all', currentSortBy: 'impact', dates: { fromDate: '2026-10-04', toDate: '2026-10-04' },
      getDateParams() { return context.dates; }, formatRelativeTime() { return '1 day ago'; },
      document: { getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', disabled: false, scrollIntoView() {} });
        return elements.get(id);
      } },
      fetch: async (url: string) => {
        assert.match(url, /^\/api\/home-news\?symbol=(AAPL|NVDA)$/);
        calls++;
        if (fail) throw new Error('Network unavailable');
        return { ok: true, json: async () => ({ news: url.endsWith('AAPL') ? docs : [] }) };
      },
    };
    await runInNewContext(source + 'Promise.all([fetchNews(), fetchTopNews()]);', context);
    assert.equal(calls, 1);
    assert.match(elements.get('newsList').innerHTML, /Article 124/);
    assert.match(elements.get('newsPageInfo').textContent, /Articles 1–10/);
    assert.match(elements.get('topNewsGrid').innerHTML, /Article 124/);
    await runInNewContext('fetchNews(12);', context);
    assert.match(elements.get('newsPageInfo').textContent, /Articles 121–125/);
    assert.equal(elements.get('newsNext').disabled, true);
    context.currentSentiment = 'breaking';
    await runInNewContext('fetchNews();', context);
    assert.ok(!elements.get('newsList').innerHTML.includes('Article 124'));
    context.dates = { fromDate: '2026-10-05', toDate: '2026-10-05' };
    now += 31000;
    await runInNewContext('Promise.all([fetchNews(), fetchTopNews()]);', context);
    assert.match(elements.get('newsList').innerHTML, /No news articles/);
    assert.match(elements.get('topNewsGrid').innerHTML, /No high-impact news/);
    assert.equal(calls, 1, 'date changes after TTL expiry still filter locally');
    context.dates = { fromDate: '2026-10-04', toDate: '2026-10-04' };
    context.currentSentiment = '0';
    context.currentSortBy = 'date';
    await runInNewContext('fetchNews();', context);
    assert.match(elements.get('newsList').innerHTML, /Article 124/);
    assert.equal(calls, 1);
    fail = true;
    await runInNewContext('Promise.all([fetchNews(0, true), fetchTopNews(true)]);', context);
    assert.equal(calls, 2, 'one shared refresh for feed and spotlight');
    assert.match(elements.get('newsList').innerHTML, /Article 124/);
    await runInNewContext('fetchNews(0, true);', context);
    assert.equal(calls, 2, 'retry backoff after failed refresh');
    fail = false;
    now += 5001;
    context.interestSymbols = ['AAPL', 'NVDA'];
    await runInNewContext('Promise.all([fetchNews(0, true), fetchTopNews(true)]);', context);
    assert.equal(calls, 4, 'one refresh for AAPL and one cold load for NVDA');
    context.singleSymbolFilter = 'NVDA';
    await runInNewContext('fetchNews();', context);
    assert.match(elements.get('newsList').innerHTML, /No news articles/);
    assert.equal(calls, 4);
    // Exact UTC boundaries are inclusive; outside dates never leak into a selected window.
    context.boundaries = [
      { _id: 1, publishedAt: '2026-10-04T00:00:00.000Z' },
      { _id: 2, publishedAt: '2026-10-04T23:59:59.999Z' },
      { _id: 3, publishedAt: '2026-10-03T23:59:59.999Z' },
      { _id: 4, publishedAt: '2026-10-05T00:00:00.000Z' },
    ];
    const ids = runInNewContext("filterHomeNews(boundaries, 'date').map(n => n._id);", context);
    assert.equal(JSON.stringify(ids), '[2,1]');
  });

  it('caches homepage news per filter and page, keeps stale results, and retries failed cold loads', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const feedStorage = new PredictionStorageService();
    const sample = (await storage.getRecentNews({ limit: 1 }))[0]!;
    const load = t.mock.method(feedStorage, 'getRecentNews', async () => [sample]);
    const feedServer = createWebServer({ port: 0, watchlist: ['AAPL', 'NVDA'], storage: feedStorage,
      poller: mockPoller, elevenlabsService: new ElevenLabsService() });
    t.after(() => new Promise<void>(resolve => feedServer.close(() => resolve())));
    await new Promise<void>(resolve => feedServer.once('listening', resolve));
    const address = feedServer.address() as { port: number };
    const read = async (path: string) => {
      const res = await fetch(`http://localhost:${address.port}${path}`);
      return { status: res.status, data: await res.json() };
    };
    await Promise.all([read('/api/news?limit=1'), read('/api/news?limit=1')]);
    assert.equal(load.mock.callCount(), 1);
    await read('/api/news?limit=1&offset=1');
    await read('/api/news?limit=1&symbol=AAPL');
    await read('/api/top-news');
    await read('/api/top-news');
    assert.equal(load.mock.callCount(), 4);
    for (const limit of ['0', '201', 'abc']) assert.equal((await read('/api/top-news?limit=' + limit)).status, 400);
    assert.equal(load.mock.callCount(), 4);
    load.mock.mockImplementation(async () => { throw new Error('Mongo unavailable'); });
    t.mock.timers.tick(30001);
    assert.equal((await read('/api/news?limit=1')).data.news[0]._id, sample._id);
    assert.equal(load.mock.callCount(), 5);
    assert.equal((await read('/api/news?limit=1&symbol=MSFT')).status, 500);
    load.mock.mockImplementation(async () => [sample]);
    assert.equal((await read('/api/news?limit=1&symbol=MSFT')).status, 200);
    assert.equal(load.mock.callCount(), 7);
  });

  it('returns all symbol news in the selected date window for UI pagination', async () => {
    const now = Math.floor(Date.now() / 1000);
    const classification = {
      sentiment: 1 as const, label: 'BULLISH' as const, confidence: 0.9,
      probabilities: { bullish: 0.9, bearish: 0.1 }, rawChoice: 'bullish' as const,
      priority: 'NOTABLE_CATALYST' as const, priorityConfidence: 0.9,
      priorityProbabilities: { breaking_critical: 0.1, notable_catalyst: 0.8, routine_noise: 0.1 },
      isBreaking: false, urgencyScore: 0.6,
    };
    for (let i = 0; i < 128; i++) {
      await storage.savePrediction({
        id: 8000 + i, category: 'company', related: i === 127 ? 'OTHER' : 'MSFT',
        datetime: i === 125 ? now - 9 * 86400 : i === 126 ? now + 86400
          : now - (i === 124 ? 3 * 86400 : 3600) - i,
        headline: 'News ' + i, summary: '', source: 'Test', url: '', image: '',
      }, classification);
    }
    const week = await get('/api/chart/MSFT?range=7d');
    assert.equal(week.status, 200);
    assert.equal(week.data.news.length, 125);
    assert.ok(week.data.news.every((n: any) => n.symbol === 'MSFT'));
    assert.ok(week.data.news.some((n: any) => n._id === 8124));
    for (const id of [8125, 8126, 8127]) {
      assert.ok(!week.data.news.some((n: any) => n._id === id));
    }
    const day = await get('/api/chart/MSFT?range=24h');
    assert.equal(day.data.news.length, 124);
    assert.ok(!day.data.news.some((n: any) => n._id === 8124));
    assert.equal((await storage.getRecentNews({ symbol: 'MSFT', limit: 10 })).length, 10);
  });
});
