import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { envSchema } from '../src/config/env.js';

describe('Environment Configuration & Validation', () => {
  const baseValidEnv = {
    FINNHUB_API_KEY: 'test_finnhub_key',
    TYPESAFE_API_KEY: 'test_typesafe_key',
    TELEGRAM_BOT_TOKEN: '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ',
    TELEGRAM_CHAT_ID: '123456789',
  };

  it('defaults to the exact 12-symbol watchlist', () => {
    const result = envSchema.parse(baseValidEnv);
    assert.deepEqual(result.WATCHLIST, [
      'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD',
      'TSM', 'BABA', 'TCEHY', 'XIACY',
    ]);
  });

  it('should default HISTORY_SYNC_DAYS to 7 (1 week)', () => {
    const result = envSchema.safeParse(baseValidEnv);
    assert.ok(result.success);
    assert.equal(result.data.HISTORY_SYNC_DAYS, 7);
  });

  it('should parse custom HISTORY_SYNC_DAYS within valid range', () => {
    const result = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: '3',
    });
    assert.ok(result.success);
    assert.equal(result.data.HISTORY_SYNC_DAYS, 3);

    const fiveYearResult = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: '7',
    });
    assert.ok(fiveYearResult.success);
    assert.equal(fiveYearResult.data.HISTORY_SYNC_DAYS, 7);
  });

  it('should reject invalid HISTORY_SYNC_DAYS values', () => {
    for (const value of ['8', '365', '1.5', '7days', '']) {
      assert.equal(envSchema.safeParse({ ...baseValidEnv, HISTORY_SYNC_DAYS: value }).success, false);
    }
    // 0 disables historical sync.
    const zeroResult = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: '0',
    });
    assert.equal(zeroResult.success, true);
    if (zeroResult.success) assert.equal(zeroResult.data.HISTORY_SYNC_DAYS, 0);

    // Negative is invalid
    const negResult = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: '-30',
    });
    assert.equal(negResult.success, false);

    // > 1825 days (> 5 years) is invalid
    const tooLargeResult = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: '2000',
    });
    assert.equal(tooLargeResult.success, false);

    // Non-numeric string is invalid
    const strResult = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: 'invalid',
    });
    assert.equal(strResult.success, false);
  });

  it('should successfully validate environment when Telegram credentials are omitted', () => {
    const withoutTelegram = {
      FINNHUB_API_KEY: 'test_finnhub_key',
      TYPESAFE_API_KEY: 'test_typesafe_key',
    };

    const result = envSchema.safeParse(withoutTelegram);
    assert.ok(result.success);
    assert.equal(result.data.TELEGRAM_BOT_TOKEN, undefined);
    assert.equal(result.data.TELEGRAM_CHAT_ID, undefined);
  });

  it('should reject malformed TELEGRAM_BOT_TOKEN when provided', () => {
    const invalidToken = {
      FINNHUB_API_KEY: 'test_finnhub_key',
      TYPESAFE_API_KEY: 'test_typesafe_key',
      TELEGRAM_BOT_TOKEN: 'not_a_valid_bot_token_format',
      TELEGRAM_CHAT_ID: '123456789',
    };

    const result = envSchema.safeParse(invalidToken);
    assert.equal(result.success, false);
  });
});
