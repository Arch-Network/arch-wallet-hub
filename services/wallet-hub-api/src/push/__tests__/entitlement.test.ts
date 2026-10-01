import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../config/env.js";
import {
  EntitlementConfigurationError,
  EntitlementUpstreamError,
  isPushEntitled,
} from "../entitlement.js";

function config(overrides: Partial<Env> = {}): Env {
  return {
    INDEXER_BASE_URL: "https://indexer.example/api/v1/testnet",
    INDEXER_INTERNAL_BASE_URL: undefined,
    INDEXER_SERVICE_KEY: "service-secret",
    INDEXER_TIMEOUT_MS: 1_000,
    ...overrides,
  } as Env;
}

describe("isPushEntitled", () => {
  it("calls the internal by-app endpoint with the dedicated service key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ entitled: true }), { status: 200 }),
    );

    await expect(
      isPushEntitled(config(), "app-id", fetchMock as typeof fetch),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://indexer.example/api/v1/internal/push-entitlements/by-app/app-id",
      expect.objectContaining({
        headers: {
          authorization: "Bearer service-secret",
          "x-service-key": "service-secret",
        },
      }),
    );
  });

  it("fails closed for unlinked or disabled apps", async () => {
    const notLinked = vi.fn(async () => new Response(null, { status: 404 }));
    const disabled = vi.fn(async () =>
      new Response(JSON.stringify({ entitled: false }), { status: 200 }),
    );

    await expect(
      isPushEntitled(config(), "app-id", notLinked as typeof fetch),
    ).resolves.toBe(false);
    await expect(
      isPushEntitled(config(), "app-id", disabled as typeof fetch),
    ).resolves.toBe(false);
  });

  it("distinguishes missing config and upstream failure", async () => {
    await expect(
      isPushEntitled(
        config({
          INDEXER_BASE_URL: undefined,
          INDEXER_INTERNAL_BASE_URL: undefined,
        }),
        "app-id",
      ),
    ).rejects.toBeInstanceOf(EntitlementConfigurationError);

    const failed = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(
      isPushEntitled(config(), "app-id", failed as typeof fetch),
    ).rejects.toBeInstanceOf(EntitlementUpstreamError);
  });
});
