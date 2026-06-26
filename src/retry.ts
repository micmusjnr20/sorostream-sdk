export interface RetryOptions {
  /** Maximum number of attempts (default: 3). */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 200). */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 5000). */
  maxDelayMs?: number;
  /** Optional AbortSignal to cancel retries mid-flight. */
  signal?: AbortSignal;
}

/**
 * Wraps an async function with configurable exponential-backoff retry and full jitter.
 *
 * Uses the AWS "full jitter" formula to spread retry load:
 *   delay = random(0, min(maxDelayMs, baseDelayMs * 2^attempt))
 *
 * @param fn - Async function to execute.
 * @param options - Retry configuration.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 200;
  const maxDelayMs = options?.maxDelayMs ?? 5_000;
  const signal = options?.signal;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException("Retry aborted", "AbortError");
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        const delay = Math.floor(Math.random() * cap);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
