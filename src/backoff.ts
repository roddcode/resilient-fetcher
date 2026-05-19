/** sleep = random(0, min(cap, base * 2^attempt)) — Full Jitter per AWS recommendation. */
export function calculateBackoff(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
): number {
  return Math.random() * Math.min(maxDelay, baseDelay * (1 << attempt));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
