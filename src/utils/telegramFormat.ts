import type { FinnhubNewsArticle } from '../types/finnhub.js';
import type { JevSentimentResult } from '../types/jev.js';

/**
 * Escapes characters with special meaning in Telegram HTML parse mode:
 * '&' -> '&amp;'
 * '<' -> '&lt;'
 * '>' -> '&gt;'
 */
export function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Formats confidence score as a percentage and visual bar indicator.
 */
function formatConfidenceBar(confidence: number): string {
  const percent = Math.round(confidence * 100);
  const totalBlocks = 10;
  const filledBlocks = Math.min(totalBlocks, Math.max(0, Math.round(confidence * totalBlocks)));
  const bar = '■'.repeat(filledBlocks) + '□'.repeat(totalBlocks - filledBlocks);
  return `${bar} ${percent}%`;
}

/**
 * Formats a news article and its Jev classification into a Telegram HTML message.
 */
export function formatNewsAlertHtml(
  article: FinnhubNewsArticle,
  classification: JevSentimentResult
): string {
  const isBullish = classification.sentiment === 1;
  const badgeEmoji = isBullish ? '🟢' : '🔴';
  const signalText = isBullish ? 'BULLISH (1)' : 'BEARISH (0)';

  const escapedSymbol = escapeHtml(article.related || 'MARKET');
  const escapedHeadline = escapeHtml(article.headline);
  const escapedSummary = escapeHtml(
    article.summary.length > 300
      ? article.summary.substring(0, 300) + '...'
      : article.summary
  );
  const escapedSource = escapeHtml(article.source || 'Finnhub');
  const safeUrl = article.url ? escapeHtml(article.url) : '';

  const dateStr = new Date(article.datetime * 1000).toISOString().replace('T', ' ').substring(0, 16) + ' UTC';
  const confidenceBar = formatConfidenceBar(classification.confidence);

  return [
    `${badgeEmoji} <b>[${escapedSymbol}] ${signalText}</b>`,
    `<b>Confidence:</b> <code>${confidenceBar}</code>`,
    `<b>Probabilities:</b> Bullish ${(classification.probabilities.bullish * 100).toFixed(1)}% | Bearish ${(classification.probabilities.bearish * 100).toFixed(1)}%`,
    '',
    `📰 <b><a href="${safeUrl}">${escapedHeadline}</a></b>`,
    '',
    `<i>${escapedSummary}</i>`,
    '',
    `⏱ <code>${dateStr}</code> | 📡 <i>${escapedSource}</i> (ID: #${article.id})`,
    `⚡ <i>Powered by TypeSafe AI System 1 (Jev)</i>`,
  ].join('\n');
}
