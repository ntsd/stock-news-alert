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

  it('should default HISTORY_SYNC_DAYS to 365 (1 year)', () => {
    const result = envSchema.safeParse(baseValidEnv);
    assert.ok(result.success);
    assert.equal(result.data.HISTORY_SYNC_DAYS, 365);
  });

  it('should parse custom HISTORY_SYNC_DAYS within valid range', () => {
    const result = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: '90',
    });
    assert.ok(result.success);
    assert.equal(result.data.HISTORY_SYNC_DAYS, 90);

    const fiveYearResult = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: '1825',
    });
    assert.ok(fiveYearResult.success);
    assert.equal(fiveYearResult.data.HISTORY_SYNC_DAYS, 1825);
  });

  it('should reject invalid HISTORY_SYNC_DAYS values', () => {
    // 0 is invalid (< 1 day)
    const zeroResult = envSchema.safeParse({
      ...baseValidEnv,
      HISTORY_SYNC_DAYS: '0',
    });
    assert.equal(zeroResult.success, false);

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
});
