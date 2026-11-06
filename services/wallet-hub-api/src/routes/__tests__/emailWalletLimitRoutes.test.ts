import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A locked app id must reject the extra wallet before Turnkey is called,
 * and must drop the reservation when the create does not commit.
 */

const USER_ID = "user-1";

const mocks = vi.hoisted(() => {
  const turnkey = {
    createSubOrganizationWithWallet: vi.fn(async () => created()),
    createSubOrganizationWithEmailWallet: vi.fn(async () => created()),
    getWalletAccountsForOrganization: vi.fn(async () => ({
      accounts: [{ address: "tb1p-new", publicKey: "02" + "aa".repeat(32) }],
    })),
  };
  return {
    turnkey,
    acquireEmailWalletSlot: vi.fn(async (): Promise<
      | { kind: "skip" }
      | { kind: "reserved"; claimId: string }
      | { kind: "rejected"; code: string; message: string }
    > => ({ kind: "skip" })),
    releaseEmailWalletClaim: vi.fn(async () => undefined),
    markIdempotencyFailed: vi.fn(async () => undefined),
    insertTurnkeyResource: vi.fn(async (_c: unknown, p: any) => ({ id: "resource-1", ...p })),
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
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
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
  updateUserRecoveryEmail: async () => undefined,
}));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  insertTurnkeyResource: mocks.insertTurnkeyResource,
  markIdempotencySucceeded: async () => undefined,
  markIdempotencyFailed: mocks.markIdempotencyFailed,
}));
vi.mock("../../db/emailWalletLimit.js", () => ({
  acquireEmailWalletSlot: mocks.acquireEmailWalletSlot,
  releaseEmailWalletClaim: mocks.releaseEmailWalletClaim,
  getAppEmailWalletLimit: async () => null,
  emailWalletLimitError: {
    email_wallet_limit_reached: "This app allows a limited number of wallets per email",
    recovery_email_locked: "Recovery email is already set for this user",
    email_required: "This app requires an email address to create a wallet",
    email_wallet_import_locked:
      "This app locks wallet creation to an email quota; import is not available",
    email_wallet_limit_exceeds_existing: "Existing wallets for an email already exceed this limit",
  },
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
    name: "email wallet",
    url: "/v1/turnkey/email-wallets",
    create: () => mocks.turnkey.createSubOrganizationWithEmailWallet,
    payload: { externalUserId: "ext-1", userEmail: "one@example.com" },
  },
  {
    name: "passkey wallet",
    url: "/v1/turnkey/passkey-wallets",
    create: () => mocks.turnkey.createSubOrganizationWithWallet,
    payload: {
      externalUserId: "ext-1",
      userEmail: "one@example.com",
      passkey: { challenge: "Y2hhbGxlbmdl", attestation: {} },
    },
  },
] as const;

describe.each(routes)("$name create respects the app email lock", ({ url, create, payload }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.acquireEmailWalletSlot.mockResolvedValue({ kind: "skip" });
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

  it("does not call Turnkey when the email is already at the cap", async () => {
    mocks.acquireEmailWalletSlot.mockResolvedValue({
      kind: "rejected",
      code: "email_wallet_limit_reached",
      message: "This app allows a limited number of wallets per email",
    });
    const res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "email_wallet_limit_reached" });
    expect(create()).not.toHaveBeenCalled();
    expect(mocks.insertTurnkeyResource).not.toHaveBeenCalled();
    expect(mocks.markIdempotencyFailed).toHaveBeenCalledWith(
      expect.anything(),
      "idem-1",
      expect.objectContaining({ error: "email_wallet_limit_reached" }),
    );
    expect(mocks.releaseEmailWalletClaim).not.toHaveBeenCalled();
  });

  it("releases the reservation when Turnkey fails", async () => {
    mocks.acquireEmailWalletSlot.mockResolvedValue({ kind: "reserved", claimId: "claim-1" });
    create().mockRejectedValueOnce(new Error("turnkey down"));
    const res = await post();
    expect(res.statusCode).toBe(500);
    expect(mocks.releaseEmailWalletClaim).toHaveBeenCalledWith(expect.anything(), "claim-1");
    expect(mocks.insertTurnkeyResource).not.toHaveBeenCalled();
  });

  it("releases the reservation in the same transaction as the wallet row", async () => {
    mocks.acquireEmailWalletSlot.mockResolvedValue({ kind: "reserved", claimId: "claim-1" });
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(mocks.releaseEmailWalletClaim).toHaveBeenCalledWith(expect.anything(), "claim-1");
    expect(create()).toHaveBeenCalledTimes(1);
  });
});
