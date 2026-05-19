import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CircuitBreakerOpenError,
  createResilientFetcher,
} from '../src/index.js';

function makeResponse(status: number): Response {
  return new Response(null, { status });
}

describe('createResilientFetcher', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves on first attempt with 200', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(makeResponse(200));

    const response = await createResilientFetcher({ maxRetries: 3 })(
      'https://api.example.com/health',
    );

    expect(response.status).toBe(200);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('retries on 500 and resolves on the third attempt', async () => {
    vi.useFakeTimers();

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(200));

    const promise = createResilientFetcher({
      maxRetries: 3,
      baseDelay: 100,
      maxDelay: 1_000,
    })('https://api.example.com/data');

    await vi.runAllTimersAsync();
    const response = await promise;

    expect(response.status).toBe(200);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(3);
  });

  it('trips the circuit after sustained failures and short-circuits subsequent calls', async () => {
    const mockFetch = vi.mocked(globalThis.fetch);

    const fetcher = createResilientFetcher({
      maxRetries: 0,
      circuitBreaker: {
        minimumRequests: 3,
        failureThreshold: 100,
        cooldownDuration: 30_000,
      },
    });

    mockFetch
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    for (let i = 0; i < 3; i++) {
      await expect(fetcher('https://api.example.com/fail')).rejects.toThrow(
        'ECONNREFUSED',
      );
    }

    await expect(
      fetcher('https://api.example.com/fail'),
    ).rejects.toBeInstanceOf(CircuitBreakerOpenError);

    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('allows only one concurrent probe in HALF_OPEN and re-trips on failure', async () => {
    vi.useFakeTimers();

    const mockFetch = vi.mocked(globalThis.fetch);

    const fetcher = createResilientFetcher({
      maxRetries: 0,
      circuitBreaker: {
        minimumRequests: 2,
        failureThreshold: 100,
        cooldownDuration: 1_000,
      },
    });

    // Trip the circuit.
    mockFetch
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'));

    for (let i = 0; i < 2; i++) {
      await expect(fetcher('https://api.example.com/probe')).rejects.toThrow(
        'down',
      );
    }

    // Advance past cooldown so remaining <= 0 when both calls enter fire().
    await vi.advanceTimersByTimeAsync(1_001);

    // The probe itself will fail — re-trips the circuit.
    mockFetch.mockRejectedValueOnce(new Error('still down'));

    // Both calls enter fire() synchronously (no await between them).
    // Call 1: state=OPEN, remaining<=0, probing=false → claims slot, transitions to HALF_OPEN, awaits fn().
    // Call 2: state=HALF_OPEN, probing=true → throws CircuitBreakerOpenError immediately.
    const [a, b] = await Promise.allSettled([
      fetcher('https://api.example.com/probe'),
      fetcher('https://api.example.com/probe'),
    ]);

    const errors = [a, b].map(
      (r) => (r as PromiseRejectedResult).reason as Error,
    );

    const networkErrors = errors.filter((e) => e.message === 'still down');
    const circuitErrors = errors.filter(
      (e) => e instanceof CircuitBreakerOpenError,
    );

    expect(networkErrors).toHaveLength(1);
    expect(circuitErrors).toHaveLength(1);
  });
});
