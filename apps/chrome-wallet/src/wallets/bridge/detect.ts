const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait briefly for a provider global. Extensions inject at different
 * points in page load, so a single synchronous check can miss one that
 * is installed.
 */
export async function waitForProvider<T>(get: () => T | undefined | null, timeoutMs = 1500): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const provider = get();
    if (provider) return provider;
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

/** Resolve to `null` instead of waiting past `ms`, for best-effort reads from providers that may never answer. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, sleep(ms).then(() => null)]);
}
