import { traceSpan } from '../instrumentation/sentry.js';
import { withExponentialBackoff } from '../utils/retry.js';

export class ElevenLabsService {
  private readonly apiKey?: string;
  private readonly voiceId: string;
  private readonly baseUrl = 'https://api.elevenlabs.io/v1';

  constructor(apiKey?: string, voiceId = 'pNInz6obpgDQGcFmaJgB') {
    this.apiKey = apiKey;
    this.voiceId = voiceId;
  }

  public get isEnabled(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Generates a 5-10 second broadcast voice summary for the breaking news alert.
   */
  public async generateAlertVoice(
    symbol: string,
    sentiment: 'BULLISH' | 'BEARISH',
    headline: string,
    confidencePercent: number
  ): Promise<Buffer | null> {
    if (!this.isEnabled || !this.apiKey) {
      return null;
    }

    const script = `Market alert for ${symbol}. ${headline}. Sentiment is evaluated as ${sentiment} with ${confidencePercent} percent confidence.`;

    return traceSpan(
      'elevenlabs.text_to_speech',
      'ai.audio',
      { symbol, sentiment, voiceId: this.voiceId, scriptLength: script.length },
      async () => {
        return withExponentialBackoff(
          async () => {
            const url = `${this.baseUrl}/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`;
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'xi-api-key': this.apiKey!,
                'Content-Type': 'application/json',
                'Accept': 'audio/mpeg',
              },
              body: JSON.stringify({
                text: script,
                model_id: 'eleven_turbo_v2_5', // Sub-second latency model
                voice_settings: {
                  stability: 0.5,
                  similarity_boost: 0.8,
                  style: 0.2,
                },
              }),
              signal: AbortSignal.timeout(12000),
            });

            if (!response.ok) {
              const errText = await response.text().catch(() => '');
              throw new Error(`ElevenLabs API error (${response.status}): ${errText}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
          },
          {
            name: `ElevenLabs:${symbol}`,
            maxAttempts: 2,
            initialDelayMs: 1000,
          }
        );
      }
    );
  }
}
