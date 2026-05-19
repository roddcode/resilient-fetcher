import { calculateBackoff, delay } from './backoff.js';
import { CircuitBreaker } from './circuit-breaker.js';
import type { CircuitBreakerOptions } from './circuit-breaker.js';

export { CircuitBreakerOpenError } from './circuit-breaker.js';
export type { CircuitState, CircuitBreakerOptions } from './circuit-breaker.js';

export interface ResilientFetcherOptions {
  /** Retry attempts after the initial request. Total calls = maxRetries + 1. @default 3 */
  maxRetries?: number;
  /** Base backoff delay in ms. @default 200 */
  baseDelay?: number;
  /** Backoff ceiling in ms. @default 10_000 */
  maxDelay?: number;
  /** Return true to retry this response. Defaults to any 5xx. */
  shouldRetry?: (response: Response) => boolean;
  circuitBreaker?: CircuitBreakerOptions;
}

/**
 * A resilient drop-in for `globalThis.fetch`.
 *
 * @example
 * ```ts
 * export const fetcher = createResilientFetcher({
 *   maxRetries: 3,
 *   circuitBreaker: { failureThreshold: 50, cooldownDuration: 15_000 },
 * });
 * ```
 */
export type ResilientFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createResilientFetcher(
  options: ResilientFetcherOptions = {},
): ResilientFetch {
  const {
    maxRetries = 3,
    baseDelay = 200,
    maxDelay = 10_000,
    shouldRetry = (res: Response) => res.status >= 500,
    circuitBreaker: cbOptions = {},
  } = options;

  const circuit = new CircuitBreaker(cbOptions);

  return function resilientFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    return circuit.fire(async () => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          await delay(calculateBackoff(attempt - 1, baseDelay, maxDelay));
        }

        try {
          const response = await globalThis.fetch(input, init);

          if (shouldRetry(response) && attempt < maxRetries) continue;

          return response;
        } catch (err) {
          if (attempt === maxRetries) throw err;
        }
      }

      // Unreachable — TypeScript exhaustiveness guard.
      throw new Error('resilient-fetcher: exhausted retry loop');
    });
  };
}
