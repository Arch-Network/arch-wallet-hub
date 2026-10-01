import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guards for email get-or-create (POST /recovery/email/signin):
 *   - the pre-verification response is identical whether or not the email
 *     already has a wallet, and never carries ids or addresses;
 *   - the wallet (existing or new) is revealed only by /verify after
 *     OTP_AUTH succeeds; a wrong or expired code reveals nothing;
 *   - the existing-wallet lookup is pinned to the calling app.
 */

const ROOT_ORG = "root-org";
const EMAIL = "victim@example.com";

const mocks = vi.hoisted(() => {
  const challenges = new Map<string, any>();
  let seq = 0;
  const get = async (_c: unknown, p: { appId: string; id: string }) => {
    const row = challenges.get(p.id);
    return row && row.app_id === p.appId ? structuredClone(row) : null;
  };
  return {
    challenges,
    reset: () => {
      challenges.clear();
      seq = 0;
    },
    findEmailWalletByRecoveryEmail: vi.fn(async (_c: unknown, _p: any): Promise<any> => null),
    insertTurnkeyResource: vi.fn(async (_c: unknown, p: any) => ({
      id: "new-resource",
      app_id: p.appId,
      user_id: p.userId,
      organization_id: p.organizationId,
      turnkey_root_user_id: p.turnkeyRootUserId,
      wallet_id: p.walletId,
      default_address: p.defaultAddress,
      default_public_key_hex: p.defaultPublicKeyHex,
      auth_method: p.authMethod,
      created_at: "2026-10-01T00:00:00Z",
    })),
    getOrCreateUserByExternalId: vi.fn(async () => ({ id: "new-user" })),
    updateUserRecoveryEmail: vi.fn(async () => undefined),
    countRecentChallenges: vi.fn(async () => 0),
    padToMinimumDuration: vi.fn(async () => undefined),
    recovery: {
      insertRecoveryChallenge: vi.fn(async (_c: unknown, p: any) => {
        const row = {
          id: `00000000-0000-4000-8000-00000000000${++seq}`,
          app_id: p.appId,
          email_hash: p.emailHash,
          candidates: p.candidates,
          status: "pending",
          attempts: 0,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + p.ttlMs).toISOString(),
          consumed_at: null,
        };
        challenges.set(row.id, row);
        return structuredClone(row);
      }),
      getRecoveryChallenge: get,
      getRecoveryChallengeForUpdate: get,
      updateRecoveryChallengeCandidates: async (_c: unknown, p: any) => {
        challenges.get(p.id).candidates = p.candidates;
      },
      incrementRecoveryAttemptIfUnderCap: async (_c: unknown, p: any) => {
        const row = challenges.get(p.id);
        if (!row || row.status !== "pending" || row.attempts >= p.maxAttempts) return null;
        row.attempts += 1;
        return structuredClone(row);
      },
      markRecoveryChallengeStatus: async (_c: unknown, p: any) => {
        challenges.get(p.id).status = p.status;
      },
      resetRecoveryAttempts: async (_c: unknown, p: any) => {
        challenges.get(p.id).attempts = 0;
      },
    },
    turnkey: {
      createSubOrganizationWithEmailWallet: vi.fn(async () => ({
        subOrganizationId: "new-sub-org",
        rootUserId: "new-root-user",
        walletId: "new-wallet",
        addresses: ["tb1p-new-address"],
        activityId: "act-create",
      })),
      getWalletAccountsForOrganization: vi.fn(async () => ({
        accounts: [{ address: "tb1p-new-address", publicKey: "02" + "cc".repeat(32) }],
      })),
      initOtpAuth: vi.fn(async () => ({
        otpId: "otp-1",
        activityId: "act-otp",
        submitElapsedMs: 1,
        pollElapsedMs: 1,
        pollAttempts: 1,
      })),
      otpAuth: vi.fn(async (): Promise<any> => ({
        credentialBundle: "bundle",
        apiKeyId: "api-key",
        activityId: "act-auth",
      })),
    },
  };
});

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
}));
vi.mock("../../audit/audit.js", () => ({ auditEvent: async () => undefined }));
vi.mock("../../turnkey/store.js", () => ({ getTurnkeyClient: () => mocks.turnkey }));
vi.mock("../../recovery/responseFloor.js", () => ({
  padToMinimumDuration: mocks.padToMinimumDuration,
}));
vi.mock("../../db/apps.js", async (orig) => ({
  ...(await orig<typeof import("../../db/apps.js")>()),
  getOrCreateUserByExternalId: mocks.getOrCreateUserByExternalId,
  updateUserRecoveryEmail: mocks.updateUserRecoveryEmail,
}));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  findEmailWalletByRecoveryEmail: mocks.findEmailWalletByRecoveryEmail,
  insertTurnkeyResource: mocks.insertTurnkeyResource,
}));
vi.mock("../../db/recovery.js", async (orig) => ({
  ...(await orig<typeof import("../../db/recovery.js")>()),
  ...mocks.recovery,
  countRecentChallenges: mocks.countRecentChallenges,
}));

import { registerRecoveryRoutes } from "../recovery.js";
import { SIGNIN_MIN_RESPONSE_MS } from "../recoverySignin.js";

function existingWallet() {
  return {
    id: "victim-resource",
    app_id: "app",
    user_id: "victim-user",
    external_user_id: "victim-external",
    organization_id: "victim-sub-org",
    turnkey_root_user_id: "victim-root-user",
    wallet_id: "victim-wallet",
    default_address: "tb1p-victim-address",
    default_public_key_hex: "02" + "aa".repeat(32),
    auth_method: "email",
    created_at: "2026-01-01T00:00:00Z",
  };
}

async function buildServer() {
  const app = Fastify();
  app.decorate("config", { TURNKEY_ORGANIZATION_ID: ROOT_ORG } as never);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerRecoveryRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

const LEAK_PATTERN = /victim-(user|external|sub-org|wallet|resource|root-user)|tb1p-|new-(user|sub-org|wallet|resource)/;

async function signin(app: Awaited<ReturnType<typeof buildServer>>) {
  return app.inject({ method: "POST", url: "/v1/recovery/email/signin", payload: { email: EMAIL } });
}

async function startAndVerify(
  app: Awaited<ReturnType<typeof buildServer>>,
  challenge: { challengeId: string; candidateToken: string },
) {
  const start = await app.inject({
    method: "POST",
    url: "/v1/recovery/email/start",
    payload: { ...challenge, email: EMAIL },
  });
  expect(start.statusCode).toBe(200);
  return app.inject({
    method: "POST",
    url: "/v1/recovery/email/verify",
    payload: { ...challenge, code: "123456", ephemeralPublicKey: "04" + "dd".repeat(64) },
  });
}

describe("POST /recovery/email/signin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    mocks.findEmailWalletByRecoveryEmail.mockResolvedValue(null);
    mocks.countRecentChallenges.mockResolvedValue(0);
  });

  it("returns an indistinguishable pre-verification response for existing and new emails", async () => {
    const app = await buildServer();

    mocks.findEmailWalletByRecoveryEmail.mockResolvedValueOnce(existingWallet());
    const existing = await signin(app);
    const fresh = await signin(app);

    expect(existing.statusCode).toBe(200);
    expect(fresh.statusCode).toBe(200);
    const a = existing.json();
    const b = fresh.json();
    expect(Object.keys(a).sort()).toEqual(["candidateToken", "challengeId", "emailMasked", "expiresAt"]);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect(a.emailMasked).toBe(b.emailMasked);
    expect(existing.payload).not.toMatch(LEAK_PATTERN);
    expect(fresh.payload).not.toMatch(LEAK_PATTERN);

    // Both paths pad to the same latency floor from request start.
    expect(mocks.padToMinimumDuration).toHaveBeenCalledTimes(2);
    for (const call of mocks.padToMinimumDuration.mock.calls as unknown as unknown[][]) {
      expect(call[1]).toBe(SIGNIN_MIN_RESPONSE_MS);
    }
    // No Turnkey OTP is sent from signin on either path.
    expect(mocks.turnkey.initOtpAuth).not.toHaveBeenCalled();
  });

  it("never attaches anything to a caller-supplied externalUserId", async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/v1/recovery/email/signin",
      payload: { email: EMAIL, externalUserId: "attacker" },
    });
    expect(res.statusCode).toBe(200);
    const calls = mocks.getOrCreateUserByExternalId.mock.calls as unknown as Array<[unknown, any]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]![1].externalUserId).toMatch(/^email-[0-9a-f-]{36}$/);
  });

  it("returns the existing wallet only after a correct OTP and does not create another", async () => {
    const app = await buildServer();
    mocks.findEmailWalletByRecoveryEmail.mockResolvedValueOnce(existingWallet());
    const res = await signin(app);

    const verify = await startAndVerify(app, res.json());

    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({
      organizationId: "victim-sub-org",
      walletId: "victim-wallet",
      defaultAddress: "tb1p-victim-address",
      externalUserId: "victim-external",
      authMethod: "email",
      credentialBundle: "bundle",
    });
    expect(mocks.turnkey.initOtpAuth).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "victim-sub-org", userId: "victim-root-user", contact: EMAIL }),
    );
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();
    expect(mocks.insertTurnkeyResource).not.toHaveBeenCalled();
  });

  it("creates a wallet for a new email and reveals it only after a correct OTP", async () => {
    const app = await buildServer();
    const res = await signin(app);

    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).toHaveBeenCalledTimes(1);
    expect(mocks.insertTurnkeyResource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: "app", userId: "new-user", authMethod: "email" }),
    );
    expect(mocks.updateUserRecoveryEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ appId: "app", userId: "new-user", email: EMAIL }),
    );

    const verify = await startAndVerify(app, res.json());
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({
      organizationId: "new-sub-org",
      walletId: "new-wallet",
      defaultAddress: "tb1p-new-address",
      authMethod: "email",
    });
    expect(verify.json().externalUserId).toMatch(/^email-/);
  });

  it("returns no wallet details for a wrong OTP", async () => {
    const app = await buildServer();
    mocks.findEmailWalletByRecoveryEmail.mockResolvedValueOnce(existingWallet());
    const res = await signin(app);
    mocks.turnkey.otpAuth.mockRejectedValueOnce(new Error("invalid otp"));

    const verify = await startAndVerify(app, res.json());

    expect(verify.statusCode).toBe(401);
    expect(verify.payload).not.toMatch(LEAK_PATTERN);
  });

  it("returns no wallet details for an expired challenge", async () => {
    const app = await buildServer();
    mocks.findEmailWalletByRecoveryEmail.mockResolvedValueOnce(existingWallet());
    const challenge = (await signin(app)).json();
    const start = await app.inject({
      method: "POST",
      url: "/v1/recovery/email/start",
      payload: { ...challenge, email: EMAIL },
    });
    expect(start.statusCode).toBe(200);
    mocks.challenges.get(challenge.challengeId).expires_at = new Date(Date.now() - 1000).toISOString();

    const verify = await app.inject({
      method: "POST",
      url: "/v1/recovery/email/verify",
      payload: { ...challenge, code: "123456", ephemeralPublicKey: "04" + "dd".repeat(64) },
    });

    expect(verify.statusCode).toBe(410);
    expect(verify.payload).not.toMatch(LEAK_PATTERN);
    expect(mocks.turnkey.otpAuth).not.toHaveBeenCalled();
  });

  it("refuses to send the OTP to a different email than the one signed in with", async () => {
    const app = await buildServer();
    mocks.findEmailWalletByRecoveryEmail.mockResolvedValueOnce(existingWallet());
    const challenge = (await signin(app)).json();
    const start = await app.inject({
      method: "POST",
      url: "/v1/recovery/email/start",
      payload: { ...challenge, email: "attacker@example.com" },
    });
    expect(start.statusCode).toBe(400);
    expect(mocks.turnkey.initOtpAuth).not.toHaveBeenCalled();
  });

  it("rate-limits per email with the shared recovery budget, independent of wallet existence", async () => {
    const app = await buildServer();
    mocks.countRecentChallenges.mockResolvedValue(10);
    const res = await signin(app);
    expect(res.statusCode).toBe(429);
    expect(mocks.findEmailWalletByRecoveryEmail).not.toHaveBeenCalled();
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();
  });

  it("scopes the existing-wallet lookup to the calling app", async () => {
    const app = await buildServer();
    await signin(app);
    expect(mocks.findEmailWalletByRecoveryEmail).toHaveBeenCalledWith(
      expect.anything(),
      { appId: "app", email: EMAIL, rootOrganizationId: ROOT_ORG },
    );
  });
});

describe("findEmailWalletByRecoveryEmail SQL", () => {
  it("pins both turnkey_resources and users to the caller's app_id", async () => {
    const { findEmailWalletByRecoveryEmail } = await vi.importActual<
      typeof import("../../db/queries.js")
    >("../../db/queries.js");
    const query = vi.fn(async () => ({ rows: [] }));

    await findEmailWalletByRecoveryEmail({ query } as never, {
      appId: "app-a",
      email: " Victim@Example.com ",
      rootOrganizationId: ROOT_ORG,
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["app-a", "victim@example.com", ROOT_ORG]);
    expect(sql).toMatch(/r\.app_id = \$1/);
    expect(sql).toMatch(/u\.app_id = \$1/);
    expect(sql).toMatch(/u\.app_id = r\.app_id/);
    expect(sql).toMatch(/r\.organization_id <> \$3/);
  });
});
