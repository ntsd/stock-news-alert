# 🔑 API Keys & Environment Configuration Guide

This guide provides step-by-step walkthroughs for obtaining and configuring all API keys and environment variables used by **`zero-market-radar` (Zero Market Radar)**.

---

## 📋 Overview of Keys & Services

| Environment Variable | Required | Cost | Primary Purpose |
| :--- | :---: | :---: | :--- |
| [`FINNHUB_API_KEY`](#1-finnhub-api-key) | **Yes** | **Free** | Market news stream across 12 US and Hong Kong ADR equities |
| [`TYPESAFE_API_KEY`](#2-typesafe-ai-api-key) | **Yes** | **Free Tier** | System 1 Jev decision model (market sentiment & urgency scoring) |
| [`TELEGRAM_BOT_TOKEN`](#3-telegram-bot-token--chat-id-optional) | No | **Free** | Telegram push alerts (omitted = dashboard-only mode) |
| [`TELEGRAM_CHAT_ID`](#3-telegram-bot-token--chat-id-optional) | No | **Free** | Target Telegram recipient or channel ID |
| [`ELEVENLABS_API_KEY`](#4-elevenlabs-api-key--voice-id-optional) | No | **Free Tier** | Low-latency synthetic voice note dispatches & web audio |
| [`ELEVENLABS_VOICE_ID`](#4-elevenlabs-api-key--voice-id-optional) | No | **Free** | Voice actor ID (default: Adam / Financial Broadcast) |
| [`MONGODB_URI`](#5-mongodb-atlas-centralized-cache-optional) | No | **Free Tier** | Centralized prediction cache, sync checkpoints & MP3 storage |
| [`SENTRY_DSN`](#6-sentry-agent-tracing-optional) | No | **Free Tier** | Distributed OpenTelemetry trace spans & performance monitoring |

> [!TIP]
> **Minimal Setup:** You only need **`FINNHUB_API_KEY`** and **`TYPESAFE_API_KEY`** to run the complete service with the live web dashboard! All other integrations degrade gracefully if omitted.

---

## 1. Finnhub API Key

Finnhub provides real-time financial news, historical company archives, and market data.

* **Cost:** 100% Free Tier (60 requests/minute).
* **Used for:** Continuous polling of company news and cold-start historical sync.

### How to Get It:
1. Navigate to [finnhub.io/register](https://finnhub.io/register).
2. Sign up with your email or GitHub/Google account (no credit card required).
3. Once logged in, your **API Key** is displayed directly on the dashboard home screen.
4. Copy the key and set it in your `.env`:
   ```bash
   FINNHUB_API_KEY=c1234567890abcdef
   ```

---

## 2. TypeSafe AI API Key

TypeSafe AI provides **Jev**: a System 1 non-autoregressive decision model that classifies market sentiment (`bullish`/`bearish`) and urgency scores in sub-second inference.

* **Cost:** Free Developer Tier.
* **Used for:** Directional sentiment evaluation and multi-choice `news_priority` urgency scoring.

All fetched uncached articles, whether live or historical, use the same genuine Jev evaluation path; no fake baseline or fake error fallback is stored. The first rollout silently re-fetches the configured recent news window and re-evaluates legacy predictions without `evaluatedBy: 'jev'`, even previously genuine Jev results whose provenance was absent. This one-time re-evaluation may incur paid Jev usage beyond the free allowance.

### How to Get It:
1. Navigate to [typesafe.ai](https://typesafe.ai).
2. Sign in or register for developer access.
3. Open **Account Settings** -> **API Keys**.
4. Generate a new API key.
5. Copy the key and set it in your `.env`:
   ```bash
   TYPESAFE_API_KEY=ts_live_xxxxxxxxxxxxxxxxxxxxxxxx
   ```

---

## 3. Telegram Bot Token & Chat ID (Optional)

Configure Telegram to receive instant push alerts and ElevenLabs audio voice memos directly on your phone.

* **Cost:** 100% Free.
* **Used for:** Real-time push notification delivery and audio dispatches.
* **Note:** If omitted, the service runs in **Dashboard-Only Mode**.

### Step 3A: Create Your Bot with `@BotFather`
1. Open the Telegram app and search for `@BotFather` (verified bot with blue checkmark).
2. Click **Start** or send `/start`.
3. Send `/newbot`.
4. Choose a display name for your bot (e.g. `Alex Zero Market Radar`).
5. Choose a unique username ending in `bot` (e.g. `alex_zero_market_radar_bot`).
6. `@BotFather` will reply with your HTTP API token formatted like:
   `123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ`
7. Set it in your `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
   ```

### Step 3B: Find Your Numeric `TELEGRAM_CHAT_ID`
1. Start a chat with your newly created bot and click **Start** (or send any text like `"hello"`).
2. Search for `@userinfobot` or `@getmyid_bot` in Telegram.
3. Send `/start` to the bot; it will reply with your numeric **Id** (e.g. `987654321`).
4. Set it in your `.env`:
   ```bash
   TELEGRAM_CHAT_ID=987654321
   ```

*(Alternative without external bots: Open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in your browser after sending a message to your bot, and copy `"chat":{"id":123456789}}`)*.

---

## 4. ElevenLabs API Key & Voice ID (Optional)

ElevenLabs provides low-latency AI speech synthesis (`eleven_turbo_v2_5`) to broadcast audio voice dispatches on Telegram and through the web dashboard.

* **Cost:** Free Tier available (or claim 3-month Creator tier perk at [hacktoberfest.com/my](https://hacktoberfest.com/my)).
* **Used for:** Generating audio briefs attached to breaking news alerts and web playback.

### How to Get It:
1. Navigate to [elevenlabs.io](https://elevenlabs.io) and create an account.
2. Click on your profile picture / initials in the bottom-left corner.
3. Select **Profile + API Key**.
4. Click the eye icon to reveal and copy your **API Key**.
5. Set it in your `.env`:
   ```bash
   ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxx
   ENABLE_VOICE_ALERTS=true
   ```

### Choosing a Voice ID (`ELEVENLABS_VOICE_ID`):
* The service defaults to `pNInz6obpgDQGcFmaJgB` ("Adam" - deep, authoritative financial news delivery).
* To choose a different voice:
  1. Open [ElevenLabs VoiceLab](https://elevenlabs.io/app/voice-lab).
  2. Select any stock or cloned voice and click the settings/ID icon to copy the Voice ID.
  3. Set it in your `.env`:
     ```bash
     ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB
     ```

---

## 5. MongoDB Atlas Centralized Cache (Optional)

MongoDB Atlas stores shared prediction weights, restart deduplication checkpoints, incremental sync dates, and binary MP3 voice buffers.

* **Cost:** 100% Free Forever (M0 Sandbox cluster, 512MB storage).
* **Used for:** Zero duplicate alerts across container restarts, downtime backfill tracking, and shared web cache.
* **Note:** If omitted, the service falls back automatically to an internal in-memory store.

Stored Jev predictions carry `evaluatedBy: 'jev'`; sync metadata uses `evaluatedAll: true` to mark fully evaluated coverage. Historical sync sends no Telegram alerts or automatic voice dispatches. Fetch or evaluation failures are retried without advancing the sync checkpoint. Older MongoDB news and prices are retained: the recent-news limit adds no TTL or deletion, and full price archiving for future backtests is unchanged.

### How to Get It:
1. Navigate to [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas) and sign up.
2. Create a new cluster and select the **M0 Free** tier.
3. In **Security** -> **Database Access**:
   - Add a new database user with **Password Authentication**.
   - Note down the username and password.
4. In **Security** -> **Network Access**:
   - Click **Add IP Address**.
   - Select **Allow Access from Anywhere** (`0.0.0.0/0`) so cloud hosts like Render can connect.
5. In **Database** -> **Deployment**:
   - Click **Connect** on your cluster.
   - Choose **Drivers** (Node.js).
   - Copy the connection string format:
     `mongodb+srv://<username>:<password>@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority`
   - Replace `<username>` and `<password>` with your database user credentials.
6. Set it in your `.env`:
   ```bash
   MONGODB_URI=mongodb+srv://admin:MySecurePass123@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority
   MONGODB_DATABASE=zero_market_radar
   ```

---

## 6. Sentry Agent Tracing (Optional)

Sentry provides OpenTelemetry APM instrumentation to monitor Jev decision latencies, token consumption, and rate-limiting buffers.

* **Cost:** Free Developer Tier.
* **Used for:** Distributed trace spans across polling, inference, and audio generation.

### How to Get It:
1. Navigate to [sentry.io/signup](https://sentry.io/signup).
2. Create a project and select **Node.js** as the platform.
3. Navigate to **Project Settings** -> **Client Keys (DSN)**.
4. Copy the DSN URL.
5. Set it in your `.env`:
   ```bash
   SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/123456
   ```

---

## 7. Operational Tuning Parameters

These optional variables allow you to customize scheduling pace and watchlist scope:

| Variable | Default | Description |
| :--- | :---: | :--- |
| `WATCHLIST` | 12 tech & ADR tickers | Comma-separated list of symbols (e.g. `AAPL,NVDA,TSLA,MSFT`) |
| `POLL_INTERVAL_MS` | `2000` | Paced tick interval in ms (2000ms = 30 req/min, free cap: 60/min) |
| `MIN_CONFIDENCE` | `0.50` | Minimum confidence cutoff to filter out ambiguous headlines |
| `HISTORY_SYNC_DAYS`| `7` | Integer 0–7: `0` polls today's news in live alert mode without history sync or cold-start Mongo reevaluation; 1–7 enables recent news sync. Price history and archive retention are unaffected. |
| `PORT` | `3000` | Port for the live web dashboard & health check API |
| `ENABLE_HEALTH_SERVER` | `true` | Serves dashboard UI and `/health` monitoring route |
| `NODE_ENV` | `production` | Node execution environment |

News UI presets are `24H`, `3D` (default), and `7D`, with `Custom` restricted to the most recent seven days. Price chart ranges remain `24H`, `7D`, `30D`, `90D`, and `1Y`, independent of the news limit.

**Render deployment:** Set or override `HISTORY_SYNC_DAYS=7` for recent history or `0` for live-only alerts. Existing values above 7 must be changed to an integer from 0 to 7 before deploying; a default does not replace an existing environment override. With history enabled, budget for possible paid Jev re-evaluation of unmarked recent predictions during silent sync.

---

## 🚀 Complete `.env` Template

Create a `.env` file in the project root:

```bash
# =====================================================
# REQUIRED CORE KEYS (Minimal Setup for Web Sentinel)
# =====================================================
FINNHUB_API_KEY=your_finnhub_api_key_here
TYPESAFE_API_KEY=your_typesafe_api_key_here

# =====================================================
# OPTIONAL NOTIFICATION CHANNELS (Telegram Push Alerts)
# =====================================================
TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ
TELEGRAM_CHAT_ID=123456789

# =====================================================
# OPTIONAL PARTNER INTEGRATIONS
# =====================================================
# ElevenLabs Voice Synthesis
ELEVENLABS_API_KEY=your_elevenlabs_api_key_here
ELEVENLABS_VOICE_ID=pNInz6obpgDQGcFmaJgB
ENABLE_VOICE_ALERTS=true

# MongoDB Atlas Centralized Cache
MONGODB_URI=mongodb+srv://username:password@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority
MONGODB_DATABASE=zero_market_radar

# Sentry Agent Tracing
SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/123456

# =====================================================
# OPERATIONAL TUNING
# =====================================================
WATCHLIST=AAPL,MSFT,NVDA,GOOGL,AMZN,META,TSLA,AMD,TSM,BABA
POLL_INTERVAL_MS=2000
MIN_CONFIDENCE=0.50
HISTORY_SYNC_DAYS=7
PORT=3000
ENABLE_HEALTH_SERVER=true
NODE_ENV=production
```
