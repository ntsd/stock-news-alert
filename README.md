# 📈 Stock News Alert (`stock-news-alert`)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

> **Hacktoberfest Weekend Challenge: Build for a Friend (`#hf26challenge`)**  
> *Targeted for the **"Best Use of Render"** Featured Prize Category.*

---

## 💡 The Story: Built for a Friend

My friend Alex is an active retail investor who follows a concentrated portfolio of tech equities. He was drowning in financial noise: dozens of clickbait articles, press releases, and commentary every hour across Bloomberg, Yahoo Finance, and CNBC.

He asked for one simple thing:
> *"I don't need another AI writing me 500-word summaries. Just watch my tickers, filter out the noise, and send an instant Telegram alert telling me if breaking news is **Bullish (1)** or **Bearish (0)** with a confidence score, so I know whether to open my brokerage app."*

`stock-news-alert` is built to solve exactly that problem. It runs a strictly paced polling worker on **Render**, evaluates breaking news through **TypeSafe AI's Jev** (a System 1 non-autoregressive decision model), and alerts Alex in sub-second latency with actionable signals and calibrated confidence scores.

---

## ⚡ Why System 1 Decision Models Beat Generative LLMs

Traditional generative LLMs (like GPT-4 or Claude) are poorly suited for streaming event-driven financial pipelines:
1. **Latency:** LLM autoregressive token generation takes 2,000–5,000ms. Jev takes **sub-second inference**.
2. **Hallucination & Schema Breakage:** LLM "prompt-and-parse" JSON output frequently fails under high volume or unexpected punctuation.
3. **Calibrated Confidence:** Generative LLMs cannot reliably quantify their own uncertainty. Jev's System 1 model computes true calibrated probabilities and confidence metrics across discrete decision boundaries.

```
Breaking News Article ──► Jev System 1 Decision ──► Typed Binary Signal [0/1] + Confidence
```

---

## 🏗 System Architecture

```mermaid
flowchart TD
    subgraph Scheduler ["Deterministic Scheduler & Rate Limiter"]
        A[Circular Watchlist Queue\nAAPL, TSLA, NVDA...] -->|Paced 1.2s Tick| B(Finnhub News Client)
    end

    subgraph External ["Finnhub API (60 req/min Free Cap)"]
        B -->|company-news| C{Finnhub API}
        C -->|Articles Array| D[Dual-Eviction LRU Cache\nTTL: 48h | Max: 10,000]
    end

    subgraph Pipeline ["Processing Pipeline"]
        D -->|Unseen Articles Only| E[TypeSafe AI Jev\nSystem 1 Decision Engine]
        E -->|Choice: Bullish/Bearish + Conf| F{Confidence Filter\nconf >= MIN_CONFIDENCE}
        F -->|Pass| G[HTML Message Formatter\nStrict Entity Escaper]
    end

    subgraph Delivery ["Telegram Delivery & Monitoring"]
        G --> H[Outbound 1 msg/s Queue]
        H --> I[(Telegram Bot API)]
        I --> J[Instant Alert to Alex]
        K[HTTP Health Server :3000\n/health] -.->|Keepalive & Stats| L[Render Cloud]
    end
```

---

## 🛡 Production Engineering Features

1. **Guaranteed Finnhub Rate Limit Compliance:**
   - Finnhub's free tier has a hard ceiling of 60 requests/minute.
   - The scheduler uses a **drift-compensated self-scheduling tick** set to `1,200ms` (~50 req/min), leaving a 10-call safety buffer for network retries and clock skew.
2. **Dual-Eviction Deduplication Cache (LRU + TTL):**
   - Articles are indexed in an in-memory Bounded LRU Cache (capacity 10,000, 48-hour TTL) with $O(1)$ amortized lookup.
   - Consumes $< 1\text{MB}$ of heap, guaranteeing stable memory over months of execution.
3. **Cold-Start Storm Protection:**
   - On initial boot, the first fetch across each symbol seeds the cache with historical articles *without* firing alerts, preventing startup notification floods.
4. **Outbound Telegram Queue with Entity Escaping:**
   - Throttled at 1 message/second to respect Telegram's rate limits.
   - Strict HTML escaping for `&`, `<`, and `>` ensures messages never fail on ticker symbols or financial punctuation (e.g. `AT&T`, `S&P 500`, `P/E > 25`).
5. **Render Blueprint Infrastructure-as-Code:**
   - Native `render.yaml` blueprint with zero-downtime health checking via `/health`.

---

## 🚀 Deployment to Render

Deploy this service directly to Render with one click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Manual Blueprint Setup on Render

1. Fork or push this repository to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** $\to$ **Blueprint**.
3. Connect your repository. Render automatically reads [`render.yaml`](render.yaml).
4. Supply your secret environment variables when prompted:
   - `FINNHUB_API_KEY`
   - `TYPESAFE_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Click **Apply**. Render will build and deploy the web service with automated health checks on `/health`.

---

## ⚙️ Configuration & Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `FINNHUB_API_KEY` | **Yes** | — | Finnhub API Key for financial news |
| `TYPESAFE_API_KEY` | **Yes** | — | TypeSafe AI API Key for Jev decision model |
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Telegram Bot token (`<bot_id>:<token>`) |
| `TELEGRAM_CHAT_ID` | **Yes** | — | Target Telegram Chat or User ID |
| `WATCHLIST` | No | `AAPL,TSLA,NVDA,MSFT,AMZN,GOOGL` | Comma-separated list of ticker symbols |
| `POLL_INTERVAL_MS` | No | `1200` | Paced interval between ticker polls (min: `1000`) |
| `MIN_CONFIDENCE` | No | `0.50` | Minimum confidence cutoff (0.0 to 1.0) |
| `PORT` | No | `3000` | HTTP port for Render health checks (Render sets `10000`) |
| `ENABLE_HEALTH_SERVER`| No | `true` | Enables native HTTP `/health` server |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |

---

## 💻 Local Development

### Prerequisites
- Node.js 20+ (tested on Node 22 & 26)
- npm 10+

### Setup
```bash
# Clone the repository
git clone https://github.com/ntsd/stock-news-alert.git
cd stock-news-alert

# Install dependencies
npm install

# Copy environment template and fill in your keys
cp .env.example .env
```

### Running Locally
```bash
# Start in development mode with live watch
npm run dev

# Run unit test suite
npm test

# Build production bundle
npm run build

# Start production server
npm start
```

### Health Check Endpoint
When running, inspect service metrics at:
```bash
curl http://localhost:3000/health
```
```json
{
  "status": "healthy",
  "service": "stock-news-alert",
  "uptimeSeconds": 42,
  "timestamp": "2026-10-04T14:48:00.000Z",
  "stats": {
    "isRunning": true,
    "totalPolls": 35,
    "articlesSeen": 18,
    "alertsSent": 4,
    "lastPollTime": "2026-10-04T14:47:59.123Z",
    "currentSymbol": "NVDA",
    "watchlistSize": 6,
    "cacheSize": 18,
    "seededSymbols": ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN", "GOOGL"]
  }
}
```

---

## 🧪 Testing

The repository includes a comprehensive unit test suite running on Node's native test runner:
- **LRU & TTL Eviction:** Tests capacity boundaries, least-recently-used eviction, and expiration.
- **Telegram HTML Escaping:** Verifies complete neutralization of `&`, `<`, and `>` characters to prevent Telegram API `400 Bad Request` parse failures.

```bash
npm test
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
