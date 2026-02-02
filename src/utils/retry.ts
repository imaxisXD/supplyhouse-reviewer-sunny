export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  jitter?: boolean;
  retryOn?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "retryOn">> = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 16000,
  jitter: true,
};

function computeDelay(attempt: number, baseDelay: number, maxDelay: number, jitter: boolean): number {
  let delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

  if (jitter) {
    delay *= 0.5 + Math.random() * 0.5;
  }

  return delay;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_OPTIONS.maxRetries;
  const baseDelay = options?.baseDelay ?? DEFAULT_OPTIONS.baseDelay;
  const maxDelay = options?.maxDelay ?? DEFAULT_OPTIONS.maxDelay;
  const jitter = options?.jitter ?? DEFAULT_OPTIONS.jitter;
  const retryOn = options?.retryOn;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // If this was the last attempt, do not retry
      if (attempt >= maxRetries) {
        break;
      }

      // If retryOn is provided, only retry when it returns true
      if (retryOn && !retryOn(error)) {
        break;
      }

      const delay = computeDelay(attempt, baseDelay, maxDelay, jitter);
      await sleep(delay);
    }
  }

  throw lastError;
}
