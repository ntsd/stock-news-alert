import { TypeSafeClient, choice } from '@typesafe-ai/sdk';
import type { FinnhubNewsArticle } from '../types/finnhub.js';
import type { JevSentimentResult } from '../types/jev.js';
import { withExponentialBackoff } from '../utils/retry.js';
import { traceSpan } from '../instrumentation/sentry.js';

export class JevClassificationService {
  private readonly client: TypeSafeClient;

  constructor(apiKey: string) {
    this.client = new TypeSafeClient({ apiKey });
  }

  /**
   * Evaluates a news article using TypeSafe AI's Jev System 1 Decision Model.
   * Employs the Choice primitive for binary directional sentiment with calibrated confidence.
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

    const criteria = {
      bullish:
        'Positive financial results, beat earnings/revenue expectations, product innovation, regulatory approval, analyst upgrade, expansion, bullish catalyst',
      bearish:
        'Negative financial results, missed earnings/revenue expectations, guidance cut, regulatory investigation or fine, lawsuits, analyst downgrade, executive turnover, bearish catalyst',
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
                market_sentiment: choice(
                  'What is the directional market sentiment of this news article for the target company/stock?',
                  criteria
                ),
              },
            });

            const answer = response.answers['market_sentiment'];
            if (!answer || answer.type !== 'choice') {
              throw new Error('Invalid or missing market_sentiment answer from Jev decision response');
            }

            const rawChoice = answer.choice as 'bullish' | 'bearish';
            const isBullish = rawChoice === 'bullish';

            const bullishProb = answer.probabilities['bullish'] ?? (isBullish ? 1 : 0);
            const bearishProb = answer.probabilities['bearish'] ?? (isBullish ? 0 : 1);

            return {
              sentiment: isBullish ? 1 : 0,
              label: isBullish ? 'BULLISH' : 'BEARISH',
              confidence: typeof answer.confidence === 'number' ? answer.confidence : 0.8,
              probabilities: {
                bullish: bullishProb,
                bearish: bearishProb,
              },
              rawChoice,
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
