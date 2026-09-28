import { address as bitcoinAddress } from "bitcoinjs-lib";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import bs58 from "bs58";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isPushEntitled: vi.fn(async () => true),
  replaceDeviceRegistration: vi.fn(async () => undefined),
  deleteDeviceRegistration: vi.fn(async () => undefined),
  lookupPushTargets: vi.fn(async () => []),
  pruneInvalidTokens: vi.fn(async () => 0),
}));

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (
    _pool: unknown,
    callback: (client: unknown) => Promise<unknown>,
  ) => callback({}),
}));
vi.mock("../../push/entitlement.js", () => ({
  EntitlementConfigurationError: class extends Error {},
  EntitlementUpstreamError: class extends Error {},
  isPushEntitled: mocks.isPushEntitled,
}));
vi.mock("../../push/store.js", () => ({
  CrossAppTokenConflict: class CrossAppTokenConflict extends Error {},
  replaceDeviceRegistration: mocks.replaceDeviceRegistration,
  deleteDeviceRegistration: mocks.deleteDeviceRegistration,
  lookupPushTargets: mocks.lookupPushTargets,
  pruneInvalidTokens: mocks.pruneInvalidTokens,
}));

import { registerPushRoutes } from "../push.js";
import { CrossAppTokenConflict } from "../../push/store.js";

async function buildServer() {
  const app = Fastify();
  app.decorate("config", {
    INDEXER_SERVICE_KEY: "service-key",
  } as never);
  app.decorate("requireSession", async (request) => {
    request.session = {
      sessionId: "session",
      appId: "app",
      userId: "user",
      externalUserId: "external-user",
    };
  });
  await app.register(sensible);
  await app.register(registerPushRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

describe("push routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("implements the exact client register and delete success contract", async () => {
    const app = await buildServer();
    const arch = bs58.encode(Buffer.alloc(32, 1));
    const btc = bitcoinAddress.toBech32(Buffer.alloc(32, 2), 1, "tb");

    const registered = await app.inject({
      method: "POST",
      url: "/v1/push/register",
      payload: {
        fcmToken: "token",
        platform: "ios",
        addresses: [
          { chain: "arch", address: arch },
          { chain: "btc", address: btc },
        ],
      },
    });
    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toEqual({ ok: true });
    expect(mocks.isPushEntitled).toHaveBeenCalledWith(
      expect.anything(),
      "app",
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/push/register",
      payload: { fcmToken: "token" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true });
    await app.close();
  });

  it("requires service authentication on internal endpoints", async () => {
    const app = await buildServer();
    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/internal/push/prune",
      payload: { fcmTokens: ["token"] },
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: "POST",
      url: "/v1/internal/push/prune",
      headers: { "x-service-key": "service-key" },
      payload: { fcmTokens: ["token"] },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ ok: true, pruned: 0 });
    await app.close();
  });

  it("returns conflict when another app already owns the token", async () => {
    const app = await buildServer();
    mocks.replaceDeviceRegistration.mockRejectedValueOnce(
      new CrossAppTokenConflict(),
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/push/register",
      payload: {
        fcmToken: "shared-token",
        platform: "ios",
        addresses: [],
      },
    });

    expect(response.statusCode).toBe(409);
    await app.close();
  });
});
