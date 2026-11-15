import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /turnkey/wallets and GET /turnkey/wallets/:id return the address and
 * public key. A user who owns a credential must present a session for
 * that same user. A user who owns nothing yet can still read, because
 * no session can exist before the wallet does.
 */

const owners = new Set<string>();

const row = {
  id: "aed4ece9-dab2-469c-95a9-f2e06a9ef777",
  user_id: "user-1",
  organization_id: "sub-org",
  turnkey_root_user_id: null,
  wallet_id: "wallet-1",
  default_address: "tb1pexample",
  default_public_key_hex: "aa",
  default_address_format: null,
  default_derivation_path: null,
  created_at: "2026-11-15T18:53:28.000Z",
  auth_method: "passkey",
};

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
}));
vi.mock("../../db/apps.js", async (orig) => ({
  ...(await orig<typeof import("../../db/apps.js")>()),
  userHasCredentials: async (_c: unknown, p: { externalUserId: string }) => owners.has(p.externalUserId),
  getUserByExternalId: async (_c: unknown, p: { externalUserId: string }) =>
    p.externalUserId === "ext-1" ? { id: "user-1" } : null,
}));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  listTurnkeyResourcesForUserForApp: async () => [row],
  getTurnkeyResourceByIdForApp: async () => row,
}));
vi.mock("../../auth/sessionToken.js", async (orig) => ({
  ...(await orig<typeof import("../../auth/sessionToken.js")>()),
  resolveSessionToken: async (_c: unknown, p: { token: string }) => {
    if (p.token === "whs_v1_owner") {
      return { sessionId: "s", appId: "app", userId: "user-1", externalUserId: "ext-1" };
    }
    if (p.token === "whs_v1_other") {
      return { sessionId: "s2", appId: "app", userId: "user-2", externalUserId: "ext-other" };
    }
    return null;
  },
}));

import { registerSessionAuth } from "../../plugins/sessionAuth.js";
import { registerTurnkeyRoutes } from "../turnkey.js";

async function buildApp() {
  const app = Fastify();
  app.decorate("config", { TURNKEY_ORGANIZATION_ID: "root-org", SESSION_ENFORCED_ROUTES: "" } as never);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerSessionAuth);
  await app.register(registerTurnkeyRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

describe("wallet metadata reads", () => {
  beforeEach(() => {
    owners.clear();
  });

  it("lists an empty account without a session", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/turnkey/wallets?externalUserId=new-user",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ externalUserId: "new-user", userId: null, wallets: [] });
    await app.close();
  });

  it("refuses the address of an existing user with no session", async () => {
    owners.add("ext-1");
    const app = await buildApp();
    const listed = await app.inject({
      method: "GET",
      url: "/v1/turnkey/wallets?externalUserId=ext-1",
    });
    const got = await app.inject({
      method: "GET",
      url: "/v1/turnkey/wallets/aed4ece9-dab2-469c-95a9-f2e06a9ef777?externalUserId=ext-1",
    });
    expect(listed.statusCode).toBe(401);
    expect(got.statusCode).toBe(401);
    expect(listed.body).not.toContain("tb1pexample");
    expect(got.body).not.toContain("tb1pexample");
    await app.close();
  });

  it("refuses a session for a different user", async () => {
    owners.add("ext-1");
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/turnkey/wallets/aed4ece9-dab2-469c-95a9-f2e06a9ef777?externalUserId=ext-1",
      headers: { authorization: "Bearer whs_v1_other" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("tb1pexample");
    await app.close();
  });

  it("returns the address to the matching session", async () => {
    owners.add("ext-1");
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/turnkey/wallets/aed4ece9-dab2-469c-95a9-f2e06a9ef777?externalUserId=ext-1",
      headers: { authorization: "Bearer whs_v1_owner" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ defaultAddress: "tb1pexample", id: row.id });
    await app.close();
  });
});
