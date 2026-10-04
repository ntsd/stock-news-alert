# 📈 Stock News Alert (`stock-news-alert`)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

> **Hacktoberfest Weekend Challenge: Build for a Friend (`#hf26challenge`)**  
> *Targeted for 4 Challenge Categories: **Best Use of Render**, **Best Use of ElevenLabs**, **Best Use of Sentry Agent Tracing**, and **Best Use of MongoDB Atlas**.*

---

## 💡 The Story: Built for a Friend

My friend Alex is an active retail investor who follows a concentrated portfolio of tech equities. He was drowning in financial noise: dozens of clickbait articles, press releases, and commentary every hour across Bloomberg, Yahoo Finance, and CNBC.

He asked for three things:
1. *"I don't need another generative AI writing me 500-word summaries. Just watch my tickers, filter out the noise, and send an instant Telegram alert telling me if breaking news is **Bullish (1)** or **Bearish (0)** with a confidence score."*
2. *"When I'm commuting or driving, send me a 5-second audio voice dispatch so I don't have to look at my phone."*
3. *"Give me a live web dashboard where I can see top ranked stocks by bullish sentiment and listen to the news on demand."*

`stock-news-alert` is built to solve exactly that. It runs on **Render**, evaluates news through **TypeSafe AI's Jev** (System 1 non-autoregressive decision model), persists predictions to a centralized **MongoDB Atlas** shared cache, generates audio dispatches via **ElevenLabs**, monitors latency with **Sentry Agent Tracing**, and delivers alerts straight to Alex's Telegram while serving a live Web Dashboard.

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

    subgraph Storage ["Centralized Prediction Cache (MongoDB Atlas)"]
        D -->|Unseen Articles| M{Shared Mongo Cache}
        M -->|Cache Hit| G[Alert Formatter]
        M -->|Cache Miss| E[TypeSafe AI Jev\nSystem 1 Decision Engine]
        E -->|Store Result| M
        E -->|Choice: Bullish/Bearish + Conf| F{Confidence Filter}
        F -->|Pass| G
    end

    subgraph Observability ["Sentry Agent Tracing"]
        E -.->|Latency & Token Spans| S[Sentry Performance Monitor]
        B -.->|Network Spans| S
    end

    subgraph Audio ["ElevenLabs Voice Engine"]
        G -->|Audio Synthesis| EL[ElevenLabs Turbo v2.5]
    end

    subgraph Delivery ["Telegram Delivery & Web Dashboard"]
        EL -->|MP3 Buffer| H[Telegram Outbound 1 msg/s Queue]
        G -->|HTML Payload| H
        H --> I[(Telegram Bot API: Text + sendVoice)]
        I --> J[Instant Alert to Alex]
        K[Web Dashboard & REST API :3000\n/api/stocks, /api/news, /health] -.->|Keepalive & Telemetry| L[Render Cloud]
    end
```

---

## 🌐 Live Web Dashboard & REST API

The service embeds a dark-mode web application and REST API at `http://localhost:3000`:
* **Top Watched Equities:** Real-time stock cards ranked by bullish sentiment ratio, confidence meter, and article volume.
* **Breaking News Feed:** Search and filter by ticker (`NVDA`, `TSLA`, etc.) and sentiment signal (Bullish / Bearish).
* **ElevenLabs Audio Playback:** Click "🎙 Listen with ElevenLabs" on any card to stream voice synthesis directly in the browser!
* **Render Telemetry:** Live health status, rate-limit consumption (~50 req/min), and cache hit metrics.

---

## 🛡 Production Engineering Features

1. **Guaranteed Finnhub Rate Limit Compliance:**
   - Free tier limit is 60 requests/minute.
   - Paced scheduler ticks at `1,200ms` (~50 req/min), leaving a 10-call safety buffer for network retries and clock skew.
2. **Centralized MongoDB Shared Cache & Startup Warm-Up:**
   - On boot, loads recent article IDs directly into the in-memory LRU cache (`getRecentArticleIds`), guaranteeing zero duplicate alerts across container restarts or Render redeployments.
   - Predictions and synthesized ElevenLabs MP3 binaries are persisted in MongoDB Atlas, sharing model decisions and audio buffers across instances.
   - Falls back gracefully to an in-memory store if `MONGODB_URI` is omitted.
3. **ElevenLabs Voice Alerts via Telegram `sendVoice`:**
   - High-confidence alerts generate audio broadcasts via ElevenLabs' low-latency `eleven_turbo_v2_5` model, sent as voice memos with HTML captions.
4. **Sentry Agent Tracing:**
   - Instruments OpenTelemetry trace spans across Jev decisions, Finnhub polling, and ElevenLabs audio generation to monitor decision latency and token efficiency.
5. **Dynamic Incremental Sync & 1-Year Historical Backfill (`HISTORY_SYNC_DAYS`):**
   - **First Run:** Queries Finnhub for the past 1 year (configurable via `HISTORY_SYNC_DAYS`, default 365 days) of news across each ticker, smartly seeds recent catalysts with Jev, and populates the historical dashboard overview silently.
   - **Subsequent Runs (e.g. After Downtime):** Tracks `lastSyncDate` per symbol in MongoDB Atlas (`sync_metadata` collection). If the bot was offline for 10 days, on startup it automatically queries from 10 days ago to today, healing all data gaps without duplicate alerts.
   - **Continuous Live Polling:** Rolls continuously over the active window, alerting breaking news in sub-second latency.
6. **Unified News Priority & Urgency Scoring:**
   - TypeSafe Jev evaluates a unified multi-choice `news_priority` decision alongside directional sentiment in a single sub-second evaluation:
     - `BREAKING_CRITICAL`: Unscheduled, high-volatility events (earnings surprises, CEO resignations, regulatory bans) trigger urgent push alerts and ElevenLabs audio broadcasts.
     - `NOTABLE_CATALYST`: Business updates, analyst upgrades/downgrades, and partnerships trigger standard alerts.
     - `ROUTINE_NOISE`: General commentary, opinion columns, and retrospective wrap-ups are safely filtered out of push alerts to prevent notification fatigue while staying searchable on the dashboard.
     - Continuous `urgencyScore` ($0.0 - 1.0$) ranks top news across all watchlists.
7. **Outbound Telegram Throttling with Strict HTML Escaping:**
   - Strict HTML escaping for `&`, `<`, and `>` ensures messages never fail on ticker symbols or financial punctuation (e.g. `AT&T`, `S&P 500`, `P/E > 25`).

---

## 🚀 Deployment to Render

Deploy this service directly to Render with one click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Render reads [`render.yaml`](render.yaml) automatically to configure the web service with automated health checks on `/health`.

---

## ⚙️ Configuration & Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `FINNHUB_API_KEY` | **Yes** | — | Finnhub API Key for financial news |
| `TYPESAFE_API_KEY` | **Yes** | — | TypeSafe AI API Key for Jev decision model |
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Telegram Bot token (`<bot_id>:<token>`) |
| `TELEGRAM_CHAT_ID` | **Yes** | — | Target Telegram Chat or User ID |
| `MONGODB_URI` | No | — | MongoDB Atlas connection string for centralized cache |
| `ELEVENLABS_API_KEY` | No | — | ElevenLabs API Key for voice note alerts |
| `ELEVENLABS_VOICE_ID` | No | `pNInz6obpgDQGcFmaJgB` | ElevenLabs Voice ID (Adam - financial broadcast) |
| `ENABLE_VOICE_ALERTS`| No | `true` | Enables ElevenLabs voice note alerts in Telegram |
| `SENTRY_DSN` | No | — | Sentry DSN for Agent Tracing & performance monitoring |
| `WATCHLIST` | No | 27 tech & US ADR tickers | Comma-separated list of ticker symbols |
| `POLL_INTERVAL_MS` | No | `2000` | Paced interval between ticker polls (30 req/min) |
| `MIN_CONFIDENCE` | No | `0.50` | Minimum confidence cutoff (0.0 to 1.0) |
| `HISTORY_SYNC_DAYS` | No | `365` | Historical lookback window in days for initial sync (1 to 1825) |
| `PORT` | No | `3000` | HTTP port for web dashboard & health check |

---

## 🧪 Testing

```bash
npm test
```

10 unit tests verify:
- Bounded LRU Cache capacity and TTL expiration
- Telegram HTML entity escaping (`&`, `<`, `>`) and priority banner rendering
- Centralized MongoDB prediction caching and top stocks ranking
- Incremental sync timestamp tracking (`getLastSyncDate` / `setLastSyncDate`)
- ElevenLabs synthesized audio buffer caching and retrieval

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
