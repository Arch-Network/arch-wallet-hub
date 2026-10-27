import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const APP_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(async (_c: unknown, params: { name: string; emailWalletLimit?: number | null }) => ({
    id: APP_ID,
    name: params.name,
    disabled_at: null,
    created_at: "2026-10-26T00:00:00.000Z",
    email_wallet_limit: params.emailWalletLimit ?? null,
  })),
  insertAppApiKey: vi.fn(async () => ({ id: "key-id" })),
  setAppEmailWalletLimit: vi.fn(async (): Promise<
    | { kind: "updated"; emailWalletLimit: number | null }
    | { kind: "not_found" }
    | { kind: "conflict"; email: string; count: number }
  > => ({ kind: "updated", emailWalletLimit: 1 })),
}));

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
}));
vi.mock("../../db/apps.js", () => ({
  createApp: mocks.createApp,
  insertAppApiKey: mocks.insertAppApiKey,
}));
vi.mock("../../platform/apiKeys.js", () => ({
  generateApiKey: () => ({ apiKey: "secret-key", keyHash: "hash", keyPrefix: "secret-k" }),
}));
vi.mock("../../db/emailWalletLimit.js", async (orig) => ({
  ...(await orig<typeof import("../../db/emailWalletLimit.js")>()),
  setAppEmailWalletLimit: mocks.setAppEmailWalletLimit,
}));

import { registerPlatformRoutes } from "../platform.js";

async function buildServer() {
  const app = Fastify();
  app.decorate("config", {
    NODE_ENV: "development",
    PLATFORM_ADMIN_API_KEY: "admin-secret",
  } as never);
  await app.register(sensible);
  await app.register(registerPlatformRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

describe("platform email wallet limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setAppEmailWalletLimit.mockResolvedValue({ kind: "updated", emailWalletLimit: 1 });
  });

  it("stores the cap when the app is created", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/platform/apps",
      headers: { "x-admin-api-key": "admin-secret" },
      payload: { name: "restricted", emailWalletLimit: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ appId: APP_ID, emailWalletLimit: 1 });
    expect(mocks.createApp).toHaveBeenCalledWith(expect.anything(), {
      name: "restricted",
      emailWalletLimit: 1,
    });
    await app.close();
  });

  it("leaves the cap unlimited when the field is omitted", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/platform/apps",
      headers: { "x-admin-api-key": "admin-secret" },
      payload: { name: "extension" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().emailWalletLimit).toBeNull();
    expect(mocks.createApp).toHaveBeenCalledWith(expect.anything(), {
      name: "extension",
      emailWalletLimit: null,
    });
    await app.close();
  });

  it("locks an existing app id", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: `/v1/platform/apps/${APP_ID}/email-wallet-limit`,
      headers: { "x-admin-api-key": "admin-secret" },
      payload: { emailWalletLimit: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ appId: APP_ID, emailWalletLimit: 1 });
    expect(mocks.setAppEmailWalletLimit).toHaveBeenCalledWith(expect.anything(), {
      appId: APP_ID,
      emailWalletLimit: 1,
    });
    await app.close();
  });

  it("refuses a cap the app's existing wallets already exceed", async () => {
    mocks.setAppEmailWalletLimit.mockResolvedValue({
      kind: "conflict",
      email: "a@example.com",
      count: 2,
    });
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: `/v1/platform/apps/${APP_ID}/email-wallet-limit`,
      headers: { "x-admin-api-key": "admin-secret" },
      payload: { emailWalletLimit: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "email_wallet_limit_exceeds_existing",
      email: "a@example.com",
      count: 2,
    });
    await app.close();
  });

  it("rejects a non-admin caller", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: `/v1/platform/apps/${APP_ID}/email-wallet-limit`,
      payload: { emailWalletLimit: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.setAppEmailWalletLimit).not.toHaveBeenCalled();
    await app.close();
  });
});
