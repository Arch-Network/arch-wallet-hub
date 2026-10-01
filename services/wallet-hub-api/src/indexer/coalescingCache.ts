/**
 * Short-lived cache for idempotent upstream reads.
 *
 * Concurrent misses for one key share a single in-flight `load`. Only
 * resolved values are stored, so a failure is retried by the next
 * request. Past `maxEntries` the oldest entry is evicted.
 */
export function createCoalescingCache<T>(opts: { ttlMs: number; maxEntries: number }) {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const inFlight = new Map<string, Promise<T>>();

  return async function cached(key: string, load: () => Promise<T>): Promise<T> {
    const hit = entries.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    let call = inFlight.get(key);
    if (!call) {
      call = load()
        .then((value) => {
          entries.delete(key);
          entries.set(key, { value, expiresAt: Date.now() + opts.ttlMs });
          if (entries.size > opts.maxEntries) entries.delete(entries.keys().next().value!);
          return value;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, call);
    }
    return call;
  };
}
