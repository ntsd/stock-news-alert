export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  jitter?: boolean;
  name?: string;
}

export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffFactor = 2,
    jitter = true,
    name = 'Operation',
  } = options;

  let attempt = 1;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (attempt >= maxAttempts) {
        throw err;
      }

      // Calculate jitter: uniform random factor between 0.8 and 1.2
      const jitterFactor = jitter ? 0.8 + Math.random() * 0.4 : 1;
      const actualDelay = Math.min(Math.round(delay * jitterFactor), maxDelayMs);

      console.warn(
        `[${name}] Attempt ${attempt}/${maxAttempts} failed: ${err instanceof Error ? err.message : String(err)}. Retrying in ${actualDelay}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, actualDelay));

      delay = Math.min(delay * backoffFactor, maxDelayMs);
      attempt++;
    }
  }
}
