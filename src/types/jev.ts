export type SentimentSignal = 1 | 0;
export type SentimentLabel = 'BULLISH' | 'BEARISH';

export interface JevArticleState {
  symbol: string;
  headline: string;
  summary: string;
  source: string;
  publishedAt: string;
}

export interface JevSentimentResult {
  sentiment: SentimentSignal;
  label: SentimentLabel;
  confidence: number;
  probabilities: {
    bullish: number;
    bearish: number;
  };
  rawChoice: 'bullish' | 'bearish';
}
