export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Thrown immediately when the circuit is OPEN.
 * Carries `.state` so consumers can discriminate without string-matching.
 */
export class CircuitBreakerOpenError extends Error {
  public readonly state: CircuitState = 'OPEN';

  constructor(cooldownRemainingMs: number) {
    super(`Circuit breaker is OPEN. Cooldown remaining: ${cooldownRemainingMs}ms`);
    this.name = 'CircuitBreakerOpenError';
    Object.setPrototypeOf(this, CircuitBreakerOpenError.prototype);
  }
}

export interface CircuitBreakerOptions {
  /** @default 5 */
  minimumRequests?: number;
  /** Failure rate (0–100) at which the circuit trips. @default 50 */
  failureThreshold?: number;
  /** Milliseconds the circuit stays OPEN before probing. @default 10_000 */
  cooldownDuration?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  /**
   * Guards the HALF_OPEN probe slot.
   * Set synchronously before the first `await` so no concurrent caller
   * can enter the probe branch while one probe is already in-flight.
   */
  private probing = false;

  private readonly minimumRequests: number;
  private readonly failureThreshold: number;
  private readonly cooldownDuration: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.minimumRequests = options.minimumRequests ?? 5;
    this.failureThreshold = options.failureThreshold ?? 50;
    this.cooldownDuration = options.cooldownDuration ?? 10_000;
  }

  async fire<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      const remaining = this.cooldownDuration - (Date.now() - this.lastFailureTime);

      if (remaining > 0) {
        throw new CircuitBreakerOpenError(remaining);
      }

      // Cooldown expired. Claim the probe slot atomically before the first await.
      if (this.probing) {
        throw new CircuitBreakerOpenError(0);
      }

      this.probing = true;
      this.state = 'HALF_OPEN';
    } else if (this.state === 'HALF_OPEN' && this.probing) {
      // Call 1 already claimed the probe slot and is in-flight (suspended at
      // `await fn()`). Any call arriving now sees HALF_OPEN, not OPEN, so the
      // branch above doesn't apply — this guard catches them.
      throw new CircuitBreakerOpenError(0);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  get currentState(): CircuitState {
    return this.state;
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.reset();
    } else {
      this.successes++;
    }
  }

  private onFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.tripOpen();
      return;
    }

    this.failures++;

    const total = this.failures + this.successes;
    if (
      total >= this.minimumRequests &&
      (this.failures / total) * 100 >= this.failureThreshold
    ) {
      this.tripOpen();
    }
  }

  private tripOpen(): void {
    this.state = 'OPEN';
    this.probing = false;
    // Clear counters so the next evaluation window starts clean.
    this.failures = 0;
    this.successes = 0;
  }

  private reset(): void {
    this.state = 'CLOSED';
    this.probing = false;
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = 0;
  }
}
