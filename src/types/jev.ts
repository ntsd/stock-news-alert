export type SentimentSignal = 1 | 0;
export type SentimentLabel = 'BULLISH' | 'BEARISH';
export type NewsPriority = 'BREAKING_CRITICAL' | 'NOTABLE_CATALYST' | 'ROUTINE_NOISE';

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

  // Unified Priority & Impact Intelligence
  priority: NewsPriority;
  priorityConfidence: number;
  priorityProbabilities: {
    breaking_critical: number;
    notable_catalyst: number;
    routine_noise: number;
  };
  isBreaking: boolean;
  urgencyScore: number; // 0.0 (pure routine noise) to 1.0 (critical breaking catalyst)
}
