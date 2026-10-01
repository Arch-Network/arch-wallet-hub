import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescingCache } from "../coalescingCache.js";

describe("createCoalescingCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares one in-flight load between concurrent misses", async () => {
    const cached = createCoalescingCache<number>({ ttlMs: 2_500, maxEntries: 10 });
    let resolve!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const a = cached("k", load);
    const b = cached("k", load);
    resolve(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves from cache within the TTL and reloads after it", async () => {
    const cached = createCoalescingCache<number>({ ttlMs: 2_500, maxEntries: 10 });
    const load = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    expect(await cached("k", load)).toBe(1);
    vi.advanceTimersByTime(2_499);
    expect(await cached("k", load)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(await cached("k", load)).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache failures, and rejects every coalesced waiter", async () => {
    const cached = createCoalescingCache<number>({ ttlMs: 2_500, maxEntries: 10 });
    const load = vi.fn().mockRejectedValueOnce(new Error("upstream 503")).mockResolvedValueOnce(3);
    const [a, b] = [cached("k", load), cached("k", load)];
    await expect(a).rejects.toThrow("upstream 503");
    await expect(b).rejects.toThrow("upstream 503");
    expect(await cached("k", load)).toBe(3);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest entry past maxEntries", async () => {
    const cached = createCoalescingCache<string>({ ttlMs: 60_000, maxEntries: 2 });
    const load = vi.fn(async () => "v");
    await cached("a", load);
    await cached("b", load);
    await cached("c", load);
    expect(load).toHaveBeenCalledTimes(3);
    await cached("b", load);
    await cached("c", load);
    expect(load).toHaveBeenCalledTimes(3);
    await cached("a", load);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
