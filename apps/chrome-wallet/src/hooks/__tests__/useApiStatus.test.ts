import { describe, expect, it, vi } from "vitest";
import { probeWithRetry } from "../useApiStatus";
import { HubRateLimitError } from "../../utils/hub-rate-limit";

describe("probeWithRetry", () => {
  it("reports a rate-limited probe without retrying it", async () => {
    const probe = vi.fn(async () => {
      throw new HubRateLimitError(30_000);
    });

    await expect(probeWithRetry(probe)).resolves.toBe("rate-limited");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("treats an upstream 429 the same way", async () => {
    const probe = vi.fn(async () => {
      throw new Error("Hub indexer error 502: upstream returned 429 Too Many Requests");
    });

    await expect(probeWithRetry(probe)).resolves.toBe("rate-limited");
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("still retries an ordinary failure once", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi
        .fn<() => Promise<unknown>>()
        .mockRejectedValueOnce(new Error("Failed to fetch"))
        .mockResolvedValueOnce({});

      const result = probeWithRetry(probe);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBe("connected");
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
