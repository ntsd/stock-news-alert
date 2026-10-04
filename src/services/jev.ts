import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
import type { FinnhubNewsArticle } from '../types/finnhub.js';
import type { JevSentimentResult, NewsPriority } from '../types/jev.js';
import { withExponentialBackoff } from '../utils/retry.js';
import { traceSpan } from '../instrumentation/sentry.js';

export class JevClassificationService {
  private readonly client: TypeSafeClient;

  constructor(apiKey: string) {
    this.client = new TypeSafeClient({ apiKey });
  }

  /**
   * Evaluates a news article using TypeSafe AI's Jev System 1 Decision Model.
   * Batches directional sentiment (Choice) and a unified news priority/urgency assessment (Choice)
   * in a single sub-second evaluation without extra network hops.
   */
  public async classifyArticleSentiment(
    article: FinnhubNewsArticle
  ): Promise<JevSentimentResult> {
    const publishedAt = new Date(article.datetime * 1000).toISOString();

    const state = {
      symbol: article.related,
      headline: article.headline,
      summary: article.summary,
      source: article.source,
      publishedAt,
    };

    return traceSpan(
      'jev.system_one_inference',
      'ai.decision',
      {
        symbol: article.related,
        articleId: article.id,
        headlineLength: article.headline.length,
      },
      async () => {
        return withExponentialBackoff(
          async () => {
            const response = await this.client.systemOne({
              state,
              questions: {
                // 1. Directional Market Sentiment
                market_sentiment: choice(
                  'What is the directional market sentiment of this news article for the target company/stock?',
                  {
                    bullish:
                      'Positive financial results, beat earnings/revenue expectations, product innovation, regulatory approval, analyst upgrade, expansion, bullish catalyst',
                    bearish:
                      'Negative financial results, missed earnings/revenue expectations, guidance cut, regulatory investigation or fine, lawsuits, analyst downgrade, executive turnover, bearish catalyst',
                  }
                ),

                // 2. Unified Priority & Market-Moving Materiality
                news_priority: choice(
                  'What is the urgency and market-moving materiality of this news for traders?',
                  {
                    breaking_critical:
                      'Urgent breaking announcement, major quarterly earnings beat/miss, M&A, regulatory ban or lawsuit, unexpected executive departure, or surprise material catalyst that immediately moves the stock',
                    notable_catalyst:
                      'Fresh business update, analyst rating upgrade or downgrade, partnership, or secondary product announcement with moderate market impact',
                    routine_noise:
                      'Generic commentary, retrospective recap, technical analysis opinion, educational column, retirement advice, or broad market listicle with no immediate price urgency',
                  }
                ),
              },
            });

            // Parse Sentiment Answer
            const sentimentAnswer = response.answers['market_sentiment'];
            if (!sentimentAnswer || sentimentAnswer.type !== 'choice') {
              throw new Error('Invalid or missing market_sentiment answer from Jev decision response');
            }

            const rawChoice = sentimentAnswer.choice as 'bullish' | 'bearish';
            const isBullish = rawChoice === 'bullish';
            const bullishProb = sentimentAnswer.probabilities['bullish'] ?? (isBullish ? 1 : 0);
            const bearishProb = sentimentAnswer.probabilities['bearish'] ?? (isBullish ? 0 : 1);
            const confidence = typeof sentimentAnswer.confidence === 'number' ? sentimentAnswer.confidence : 0.8;

            // Parse Unified Priority Answer
            const priorityAnswer = response.answers['news_priority'];
            if (!priorityAnswer || priorityAnswer.type !== 'choice') {
              throw new Error('Invalid or missing news_priority answer from Jev decision response');
            }

            const rawPriority = priorityAnswer.choice as 'breaking_critical' | 'notable_catalyst' | 'routine_noise';
            const priorityProbs = {
              breaking_critical: priorityAnswer.probabilities['breaking_critical'] ?? (rawPriority === 'breaking_critical' ? 1 : 0),
              notable_catalyst: priorityAnswer.probabilities['notable_catalyst'] ?? (rawPriority === 'notable_catalyst' ? 1 : 0),
              routine_noise: priorityAnswer.probabilities['routine_noise'] ?? (rawPriority === 'routine_noise' ? 1 : 0),
            };

            let priority: NewsPriority = 'ROUTINE_NOISE';
            if (rawPriority === 'breaking_critical') {
              priority = 'BREAKING_CRITICAL';
            } else if (rawPriority === 'notable_catalyst') {
              priority = 'NOTABLE_CATALYST';
            }

            // Continuous urgency score from 0.0 to 1.0
            const urgencyScore = Math.min(
              1.0,
              Math.max(
                0.0,
                priorityProbs.breaking_critical * 1.0 + priorityProbs.notable_catalyst * 0.5
              )
            );

            const isBreaking = priority === 'BREAKING_CRITICAL' || priorityProbs.breaking_critical >= 0.5;

            return {
              sentiment: isBullish ? 1 : 0,
              label: isBullish ? 'BULLISH' : 'BEARISH',
              confidence,
              probabilities: {
                bullish: bullishProb,
                bearish: bearishProb,
              },
              rawChoice,
              priority,
              priorityConfidence: typeof priorityAnswer.confidence === 'number' ? priorityAnswer.confidence : 0.85,
              priorityProbabilities: priorityProbs,
              isBreaking,
              urgencyScore,
            };
          },
          {
            name: `Jev:${article.related}:${article.id}`,
            maxAttempts: 3,
            initialDelayMs: 1000,
          }
        );
      }
    );
  }
}
