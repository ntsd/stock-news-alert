import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatNewsAlertHtml } from '../src/utils/telegramFormat.js';
import type { FinnhubNewsArticle } from '../src/types/finnhub.js';
import type { JevSentimentResult } from '../src/types/jev.js';

describe('Telegram Format Utilities', () => {
  it('should properly escape HTML entities to prevent Telegram parse errors', () => {
    assert.equal(escapeHtml('AT&T <S&P 500>'), 'AT&amp;T &lt;S&amp;P 500&gt;');
    assert.equal(escapeHtml('Price > $100 & Volume < 50M'), 'Price &gt; $100 &amp; Volume &lt; 50M');
    assert.equal(escapeHtml(''), '');
  });

  it('should format bullish news alert with HTML badges and links', () => {
    const article: FinnhubNewsArticle = {
      category: 'company',
      datetime: 1728000000,
      headline: 'Apple & TSMC Announce <Next-Gen> M5 Chip',
      id: 554433,
      image: 'https://example.com/img.png',
      related: 'AAPL',
      source: 'Bloomberg & Reuters',
      summary: 'Revenue forecast increased by > 20% year-over-year.',
      url: 'https://finance.yahoo.com/news/apple-m5',
    };

    const classification: JevSentimentResult = {
      sentiment: 1,
      label: 'BULLISH',
      confidence: 0.95,
      probabilities: {
        bullish: 0.95,
        bearish: 0.05,
      },
      rawChoice: 'bullish',
    };

    const formatted = formatNewsAlertHtml(article, classification);

    // Verify correct escaping in output
    assert.match(formatted, /Apple &amp; TSMC Announce &lt;Next-Gen&gt; M5 Chip/);
    assert.match(formatted, /Revenue forecast increased by &gt; 20% year-over-year\./);
    assert.match(formatted, /Bloomberg &amp; Reuters/);
    assert.match(formatted, /🟢 <b>\[AAPL\] BULLISH \(1\)<\/b>/);
    assert.match(formatted, /<b>Confidence:<\/b> <code>■■■■■■■■■■ 95%<\/code>/);
  });
});
