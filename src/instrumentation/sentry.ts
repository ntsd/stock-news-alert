import * as Sentry from '@sentry/node';

let isSentryEnabled = false;

export function initSentry(dsn?: string, environment = 'development'): void {
  if (!dsn) {
    console.log('ℹ️ [Sentry] SENTRY_DSN not provided. Agent tracing running in local mode.');
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment,
      tracesSampleRate: 1.0,
    });
    isSentryEnabled = true;
    console.log('🛡 [Sentry] Sentry Agent Tracing initialized successfully.');
  } catch (err) {
    console.warn('⚠️ [Sentry] Failed to initialize Sentry:', err);
  }
}

/**
 * Instruments an asynchronous operation with a Sentry OpenTelemetry trace span.
 */
export async function traceSpan<T>(
  name: string,
  op: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  if (!isSentryEnabled) {
    return await fn();
  }

  return Sentry.startSpan(
    {
      name,
      op,
      attributes,
    },
    async () => {
      try {
        return await fn();
      } catch (error) {
        Sentry.captureException(error, {
          extra: attributes,
        });
        throw error;
      }
    }
  );
}
