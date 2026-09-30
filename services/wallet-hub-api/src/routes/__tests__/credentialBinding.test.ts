import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guards for credential binding:
 *   - passkey import only accepts a (address, key) pair Turnkey holds for
 *     that sub-org, never the Hub's root org;
 *   - session mint verifies only against the challenge's own resource key,
 *     and only once that key is Turnkey-verified.
 */

const ROOT_ORG = "root-org";
const SUB_ORG = "sub-org-1";
const RESOURCE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RESOURCE_ID = "22222222-2222-4222-8222-222222222222";
const CHALLENGE_ID = "33333333-3333-4333-8333-333333333333";
const USER_KEY = "02" + "aa".repeat(32);
const ATTACKER_KEY = "02" + "bb".repeat(32);

const mocks = vi.hoisted(() => ({
  getOrCreateUserByExternalId: vi.fn(async () => ({ id: "user-1" })),
  insertTurnkeyResource: vi.fn(async (_c: unknown, p: any) => ({ id: "new-resource", ...p })),
  getTurnkeyResourceByIdForApp: vi.fn(async (_c: unknown, _p: any): Promise<any> => null),
  markTurnkeyResourceKeyVerifiedForApp: vi.fn(async () => null),
  loadConsumableChallenge: vi.fn(async (): Promise<any> => null),
  verifyChallengeSignature: vi.fn((_p: { defaultPublicKeyHex: string }) => false),
  mintSession: vi.fn(async () => ({ token: "whs_v1_x", sessionId: "s", expiresAt: "2030-01-01" })),
  resolveSessionToken: vi.fn(async (): Promise<any> => null),
  turnkey: {
    getWalletsForOrganization: vi.fn(async () => ({ wallets: [{ walletId: "wallet-1" }] })),
    getWalletAccountsForOrganization: vi.fn(async (): Promise<any> => ({ accounts: [] })),
  },
}));

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
}));
vi.mock("../../audit/audit.js", () => ({ auditEvent: async () => undefined }));
vi.mock("../../turnkey/store.js", () => ({ getTurnkeyClient: () => mocks.turnkey }));
vi.mock("../../db/apps.js", async (orig) => ({
  ...(await orig<typeof import("../../db/apps.js")>()),
  getOrCreateUserByExternalId: mocks.getOrCreateUserByExternalId,
}));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  insertTurnkeyResource: mocks.insertTurnkeyResource,
  getTurnkeyResourceByIdForApp: mocks.getTurnkeyResourceByIdForApp,
  markTurnkeyResourceKeyVerifiedForApp: mocks.markTurnkeyResourceKeyVerifiedForApp,
}));
vi.mock("../../auth/sessionToken.js", async (orig) => ({
  ...(await orig<typeof import("../../auth/sessionToken.js")>()),
  loadConsumableChallenge: mocks.loadConsumableChallenge,
  verifyChallengeSignature: mocks.verifyChallengeSignature,
  mintSession: mocks.mintSession,
  resolveSessionToken: mocks.resolveSessionToken,
}));

import { registerSessionAuth } from "../../plugins/sessionAuth.js";
import { registerTurnkeyRoutes } from "../turnkey.js";
import { registerAuthSessionRoutes } from "../authSessions.js";

async function buildServer() {
  const app = Fastify();
  app.decorate("config", { TURNKEY_ORGANIZATION_ID: ROOT_ORG, SESSION_ENFORCED_ROUTES: "" } as never);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerSessionAuth);
  await app.register(registerTurnkeyRoutes, { prefix: "/v1" });
  await app.register(registerAuthSessionRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

function importPayload(overrides: Record<string, unknown> = {}) {
  return {
    externalUserId: "attacker",
    organizationId: SUB_ORG,
    defaultAddress: "tb1p-victim",
    defaultPublicKeyHex: USER_KEY,
    ...overrides,
  };
}

function resource(overrides: Record<string, unknown> = {}) {
  return {
    id: RESOURCE_ID,
    app_id: "app",
    user_id: "user-1",
    organization_id: SUB_ORG,
    default_address: "tb1p-user",
    default_public_key_hex: USER_KEY,
    key_verified_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("passkey wallet import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an address/key pair Turnkey does not hold for the sub-org", async () => {
    mocks.turnkey.getWalletAccountsForOrganization.mockResolvedValue({
      accounts: [{ address: "tb1p-real", publicKey: ATTACKER_KEY }],
    });
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/turnkey/passkey-wallets/import", payload: importPayload() });
    expect(res.statusCode).toBe(400);
    expect(mocks.insertTurnkeyResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects the Hub's root organization without asking Turnkey", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/turnkey/passkey-wallets/import",
      payload: importPayload({ organizationId: ROOT_ORG }),
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.turnkey.getWalletsForOrganization).not.toHaveBeenCalled();
    expect(mocks.insertTurnkeyResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects when the Turnkey lookup fails", async () => {
    mocks.turnkey.getWalletsForOrganization.mockRejectedValueOnce(new Error("forbidden"));
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/turnkey/passkey-wallets/import", payload: importPayload() });
    expect(res.statusCode).toBe(400);
    expect(mocks.insertTurnkeyResource).not.toHaveBeenCalled();
    await app.close();
  });

  it("inserts a verified row when Turnkey holds the pair", async () => {
    mocks.turnkey.getWalletAccountsForOrganization.mockResolvedValue({
      accounts: [{ address: "tb1p-victim", publicKey: USER_KEY }],
    });
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/turnkey/passkey-wallets/import", payload: importPayload() });
    expect(res.statusCode).toBe(200);
    expect(mocks.insertTurnkeyResource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ walletId: "wallet-1", keyVerified: true, organizationId: SUB_ORG }),
    );
    await app.close();
  });

  it("no longer serves the removed /turnkey/sign-message route", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/turnkey/sign-message",
      payload: { resourceId: RESOURCE_ID, message: "hi" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("session mint", () => {
  beforeEach(() => vi.clearAllMocks());

  const mint = (app: Awaited<ReturnType<typeof buildServer>>) =>
    app.inject({ method: "POST", url: "/v1/auth/session", payload: { challengeId: CHALLENGE_ID, signatureHex: "00" } });

  it("verifies only against the challenge's resource key, not another key on the same user", async () => {
    mocks.loadConsumableChallenge.mockResolvedValue({
      id: CHALLENGE_ID,
      user_id: "user-1",
      payload_hex: "ab".repeat(32),
      resource_id: RESOURCE_ID,
    });
    mocks.getTurnkeyResourceByIdForApp.mockImplementation(async (_c: unknown, p: any) =>
      p.id === RESOURCE_ID ? resource() : resource({ id: OTHER_RESOURCE_ID, default_public_key_hex: ATTACKER_KEY }),
    );
    // The signature is the attacker's: it verifies only under ATTACKER_KEY.
    mocks.verifyChallengeSignature.mockImplementation((p) => p.defaultPublicKeyHex === ATTACKER_KEY);
    const app = await buildServer();
    const res = await mint(app);
    expect(res.statusCode).toBe(401);
    expect(mocks.mintSession).not.toHaveBeenCalled();
    for (const [args] of mocks.verifyChallengeSignature.mock.calls) {
      expect(args.defaultPublicKeyHex).toBe(USER_KEY);
    }
    await app.close();
  });

  it("refuses a resource whose key was never Turnkey-verified", async () => {
    mocks.loadConsumableChallenge.mockResolvedValue({
      id: CHALLENGE_ID,
      user_id: "user-1",
      payload_hex: "ab".repeat(32),
      resource_id: RESOURCE_ID,
    });
    mocks.getTurnkeyResourceByIdForApp.mockResolvedValue(resource({ key_verified_at: null }));
    mocks.verifyChallengeSignature.mockReturnValue(true);
    const app = await buildServer();
    const res = await mint(app);
    expect(res.statusCode).toBe(401);
    expect(mocks.mintSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses a challenge not bound to any resource", async () => {
    mocks.loadConsumableChallenge.mockResolvedValue({
      id: CHALLENGE_ID,
      user_id: "user-1",
      payload_hex: "ab".repeat(32),
      resource_id: null,
    });
    mocks.verifyChallengeSignature.mockReturnValue(true);
    const app = await buildServer();
    const res = await mint(app);
    expect(res.statusCode).toBe(400);
    expect(mocks.mintSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("mints when the challenge's own verified key signed it", async () => {
    mocks.loadConsumableChallenge.mockResolvedValue({
      id: CHALLENGE_ID,
      user_id: "user-1",
      payload_hex: "ab".repeat(32),
      resource_id: RESOURCE_ID,
    });
    mocks.getTurnkeyResourceByIdForApp.mockResolvedValue(resource());
    mocks.verifyChallengeSignature.mockImplementation((p) => p.defaultPublicKeyHex === USER_KEY);
    const app = await buildServer();
    const res = await mint(app);
    expect(res.statusCode).toBe(200);
    expect(res.json().sessionToken).toBe("whs_v1_x");
    await app.close();
  });
});
