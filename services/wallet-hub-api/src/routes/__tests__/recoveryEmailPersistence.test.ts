import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wallet creation must only write users.recovery_email once the Turnkey
 * sub-org exists: a failed create leaves the previous value (or null)
 * exactly as it was.
 */

const USER_ID = "user-1";

const mocks = vi.hoisted(() => {
  const db = { recoveryEmail: null as string | null, resources: [] as unknown[] };
  return {
    db,
    updateUserRecoveryEmail: vi.fn(async (_c: unknown, p: { email: string | null }) => {
      db.recoveryEmail = p.email ? p.email.trim().toLowerCase() : null;
    }),
    insertTurnkeyResource: vi.fn(async (_c: unknown, p: any) => {
      db.resources.push(p);
      return { id: "resource-1", ...p };
    }),
    turnkey: {
      createSubOrganizationWithWallet: vi.fn(async (): Promise<any> => created()),
      createSubOrganizationWithEmailWallet: vi.fn(async (): Promise<any> => created()),
      getWalletAccountsForOrganization: vi.fn(async () => ({
        accounts: [{ address: "tb1p-new", publicKey: "02" + "aa".repeat(32) }],
      })),
    },
  };

  function created() {
    return {
      subOrganizationId: "sub-org-1",
      rootUserId: "root-user-1",
      walletId: "wallet-1",
      addresses: ["tb1p-new"],
      activityId: "activity-1",
    };
  }
});

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
// Snapshot/restore so a throwing callback behaves like a rolled-back tx.
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => {
    const snapshot = { recoveryEmail: mocks.db.recoveryEmail, resources: [...mocks.db.resources] };
    try {
      return await cb({});
    } catch (err) {
      mocks.db.recoveryEmail = snapshot.recoveryEmail;
      mocks.db.resources = snapshot.resources;
      throw err;
    }
  },
}));
vi.mock("../../audit/audit.js", () => ({ auditEvent: async () => undefined }));
vi.mock("../../turnkey/store.js", () => ({ getTurnkeyClient: () => mocks.turnkey }));
vi.mock("../../idempotency/idempotency.js", async (orig) => ({
  ...(await orig<typeof import("../../idempotency/idempotency.js")>()),
  consumeIdempotencyKey: async () => ({ kind: "created", row: { id: "idem-1" } }),
}));
vi.mock("../../db/apps.js", async (orig) => ({
  ...(await orig<typeof import("../../db/apps.js")>()),
  userHasCredentials: async () => false,
  getOrCreateUserByExternalId: async () => ({ id: USER_ID }),
  updateUserRecoveryEmail: mocks.updateUserRecoveryEmail,
}));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  insertTurnkeyResource: mocks.insertTurnkeyResource,
  markIdempotencySucceeded: async () => undefined,
  markIdempotencyFailed: async () => undefined,
}));

import { registerSessionAuth } from "../../plugins/sessionAuth.js";
import { registerTurnkeyRoutes } from "../turnkey.js";

async function buildServer() {
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

const routes = [
  {
    name: "/turnkey/email-wallets",
    url: "/v1/turnkey/email-wallets",
    create: () => mocks.turnkey.createSubOrganizationWithEmailWallet,
    payload: { externalUserId: "ext-1", userEmail: "New@Example.com" },
  },
  {
    name: "/turnkey/passkey-wallets",
    url: "/v1/turnkey/passkey-wallets",
    create: () => mocks.turnkey.createSubOrganizationWithWallet,
    payload: {
      externalUserId: "ext-1",
      userEmail: "New@Example.com",
      passkey: { challenge: "Y2hhbGxlbmdl", attestation: {} },
    },
  },
] as const;

describe.each(routes)("$name recovery email persistence", ({ url, create, payload }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.recoveryEmail = null;
    mocks.db.resources = [];
  });

  const post = async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url,
      headers: { "idempotency-key": "idem-key" },
      payload,
    });
    await app.close();
    return res;
  };

  it("leaves a previous recovery_email unchanged when the Turnkey create fails", async () => {
    mocks.db.recoveryEmail = "previous@example.com";
    create().mockRejectedValueOnce(new Error("turnkey create failed"));
    const res = await post();
    expect(res.statusCode).toBe(500);
    expect(mocks.db.recoveryEmail).toBe("previous@example.com");
    expect(mocks.updateUserRecoveryEmail).not.toHaveBeenCalled();
  });

  it("leaves a null recovery_email null when the Turnkey create fails", async () => {
    create().mockRejectedValueOnce(new Error("turnkey create failed"));
    const res = await post();
    expect(res.statusCode).toBe(500);
    expect(mocks.db.recoveryEmail).toBeNull();
    expect(mocks.updateUserRecoveryEmail).not.toHaveBeenCalled();
  });

  it("rolls the recovery_email back with the resource insert if persisting fails", async () => {
    mocks.db.recoveryEmail = "previous@example.com";
    mocks.insertTurnkeyResource.mockRejectedValueOnce(new Error("insert failed"));
    const res = await post();
    expect(res.statusCode).toBe(500);
    expect(mocks.db.recoveryEmail).toBe("previous@example.com");
  });

  it("sets recovery_email after a successful create", async () => {
    mocks.db.recoveryEmail = "previous@example.com";
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(mocks.db.recoveryEmail).toBe("new@example.com");
    expect(mocks.db.resources).toHaveLength(1);
    expect(create()).toHaveBeenCalledTimes(1);
  });
});
