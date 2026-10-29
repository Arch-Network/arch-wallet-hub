import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression guards for email sign-in (/recovery/email/signin, /verify, /session):
 *   - /signin only sends a code: no lookup, no create, the same answer for
 *     every email;
 *   - a wallet is created only after VERIFY_OTP_V2 accepts the code, and an
 *     email signs in to one wallet: pinned, then reused;
 *   - a wrong code reveals and creates nothing;
 *   - /session opens only the wallet its verified challenge resolved.
 */

const ROOT_ORG = "root-org";
const EMAIL = "victim@example.com";

function tokenFor(contact: string): string {
  const claims = { contact, exp: 4102444800, id: "token-1", public_key: "02" + "ee".repeat(32), verification_type: "OTP_TYPE_EMAIL" };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

const mocks = vi.hoisted(() => {
  const challenges = new Map<string, any>();
  const wallets: any[] = [];
  // Stands in for pg_advisory_xact_lock: held until the transaction that took it ends.
  const locks = new Map<string, Promise<void>>();
  let seq = 0;
  const get = async (_c: unknown, p: { appId: string; id: string }) => {
    const row = challenges.get(p.id);
    return row && row.app_id === p.appId ? structuredClone(row) : null;
  };
  const created = () => ({
    subOrganizationId: "new-sub-org",
    rootUserId: "new-root-user",
    walletId: "new-wallet",
    addresses: ["tb1p-new-address"],
    activityId: "act-create",
  });
  return {
    challenges,
    wallets,
    created,
    reset: () => {
      challenges.clear();
      wallets.length = 0;
      locks.clear();
      seq = 0;
    },
    lockEmailWallets: vi.fn(async (client: { releases: Array<() => void> }, p: { appId: string; email: string }) => {
      const key = `${p.appId}:${p.email.trim().toLowerCase()}`;
      while (locks.has(key)) await locks.get(key);
      let release!: () => void;
      locks.set(key, new Promise<void>((resolve) => (release = () => (locks.delete(key), resolve()))));
      client.releases.push(release);
    }),
    findEmailWalletByVerifiedEmail: vi.fn(async (_c: unknown, p: { appId: string; email: string }) => {
      const wallet = wallets.find((w) => w.app_id === p.appId && w.verified_email === p.email.toLowerCase());
      // The real query joins users for external_user_id.
      return wallet ? { external_user_id: null, ...wallet } : null;
    }),
    findEmailWalletByRecoveryEmail: vi.fn(async (_c: unknown, _p: any): Promise<any> => null),
    pinVerifiedEmail: vi.fn(async (_c: unknown, p: { resourceId: string; email: string }) => {
      const wallet = wallets.find((w) => w.id === p.resourceId);
      if (!wallet || wallet.verified_email) throw new Error("Email wallet is already pinned to another email");
      wallet.verified_email = p.email.toLowerCase();
    }),
    insertTurnkeyResource: vi.fn(async (_c: unknown, p: any) => {
      const row = {
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
        verified_email: null,
      };
      wallets.push(row);
      return row;
    }),
    getOrCreateUserByExternalId: vi.fn(async () => ({ id: "new-user" })),
    updateUserRecoveryEmail: vi.fn(async () => undefined),
    countRecentChallenges: vi.fn(async () => 0),
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
          otp_id: p.otpId ?? null,
        };
        challenges.set(row.id, row);
        return structuredClone(row);
      }),
      getRecoveryChallenge: get,
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
    },
    turnkey: {
      initOtp: vi.fn(async (_p: any) => ({
        otpId: "otp-1",
        otpEncryptionTargetBundle: "target-bundle",
        activityId: "act-init",
      })),
      verifyOtp: vi.fn(async (_p: any): Promise<any> => ({ verificationToken: "", activityId: "act-verify" })),
      otpLogin: vi.fn(async (_p: any) => ({ session: "session-jwt", activityId: "act-login" })),
      createSubOrganizationWithEmailWallet: vi.fn(async (_p: any) => created()),
      getWalletAccountsForOrganization: vi.fn(async () => ({
        accounts: [{ address: "tb1p-new-address", publicKey: "02" + "cc".repeat(32) }],
      })),
    },
  };
});

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => {
    const client = { releases: [] as Array<() => void> };
    try {
      return await cb(client);
    } finally {
      for (const release of client.releases) release();
    }
  },
}));
vi.mock("../../audit/audit.js", () => ({ auditEvent: async () => undefined }));
vi.mock("../../turnkey/store.js", () => ({ getTurnkeyClient: () => mocks.turnkey }));
vi.mock("../../db/apps.js", async (orig) => ({
  ...(await orig<typeof import("../../db/apps.js")>()),
  getOrCreateUserByExternalId: mocks.getOrCreateUserByExternalId,
  updateUserRecoveryEmail: mocks.updateUserRecoveryEmail,
}));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  findEmailWalletByVerifiedEmail: mocks.findEmailWalletByVerifiedEmail,
  findEmailWalletByRecoveryEmail: mocks.findEmailWalletByRecoveryEmail,
  pinVerifiedEmail: mocks.pinVerifiedEmail,
  insertTurnkeyResource: mocks.insertTurnkeyResource,
  lockEmailWallets: mocks.lockEmailWallets,
}));
vi.mock("../../db/recovery.js", async (orig) => ({
  ...(await orig<typeof import("../../db/recovery.js")>()),
  ...mocks.recovery,
  countRecentChallenges: mocks.countRecentChallenges,
}));

import { registerRecoveryRoutes } from "../recovery.js";

function walletRow(overrides: Record<string, unknown> = {}) {
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
    verified_email: null as string | null,
    ...overrides,
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

type App = Awaited<ReturnType<typeof buildServer>>;

const LEAK_PATTERN = /victim-(user|external|sub-org|wallet|resource|root-user)|tb1p-|new-(user|sub-org|wallet|resource)/;

const signin = (app: App, email = EMAIL) =>
  app.inject({ method: "POST", url: "/v1/recovery/email/signin", payload: { email } });

const verify = (app: App, challengeId: string) =>
  app.inject({
    method: "POST",
    url: "/v1/recovery/email/signin/verify",
    payload: { challengeId, encryptedOtpBundle: "encrypted-otp-bundle" },
  });

const session = (app: App, challengeId: string) =>
  app.inject({
    method: "POST",
    url: "/v1/recovery/email/signin/session",
    payload: {
      challengeId,
      verificationToken: tokenFor(EMAIL),
      publicKey: "02" + "ee".repeat(32),
      clientSignature: {
        scheme: "CLIENT_SIGNATURE_SCHEME_API_P256",
        publicKey: "02" + "ee".repeat(32),
        message: '{"login":{"publicKey":"02ee"},"tokenId":"token-1","type":"USAGE_TYPE_LOGIN"}',
        signature: "ab".repeat(64),
      },
    },
  });

describe("email sign-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    mocks.countRecentChallenges.mockResolvedValue(0);
    mocks.findEmailWalletByRecoveryEmail.mockResolvedValue(null);
    mocks.turnkey.verifyOtp.mockResolvedValue({ verificationToken: tokenFor(EMAIL), activityId: "act-verify" });
  });

  it("/signin sends a code without looking up or creating a wallet, and answers every email alike", async () => {
    const app = await buildServer();
    mocks.wallets.push(walletRow({ verified_email: EMAIL }));

    const known = await signin(app);
    const unknown = await signin(app, "nobody@example.com");

    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(Object.keys(known.json()).sort()).toEqual(["challengeId", "emailMasked", "expiresAt", "otpEncryptionTargetBundle"]);
    expect(Object.keys(unknown.json()).sort()).toEqual(Object.keys(known.json()).sort());
    expect(known.payload).not.toMatch(LEAK_PATTERN);
    expect(mocks.turnkey.initOtp).toHaveBeenCalledWith(
      expect.objectContaining({ contact: EMAIL, appName: "Arch Wallet", expirationSeconds: "600" }),
    );
    expect(mocks.findEmailWalletByVerifiedEmail).not.toHaveBeenCalled();
    expect(mocks.findEmailWalletByRecoveryEmail).not.toHaveBeenCalled();
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();
    expect(mocks.challenges.get(known.json().challengeId)).toMatchObject({ otp_id: "otp-1", candidates: [] });
  });

  it("rate-limits per email before sending a code", async () => {
    const app = await buildServer();
    mocks.countRecentChallenges.mockResolvedValue(10);
    const res = await signin(app);
    expect(res.statusCode).toBe(429);
    expect(mocks.turnkey.initOtp).not.toHaveBeenCalled();
    // /init rows exist only for emails with a wallet; counting them would leak that.
    expect(mocks.countRecentChallenges).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ signinOnly: true }));
  });

  it("creates a wallet only after the code verifies, pins it to the email, and reveals it", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();

    const res = await verify(app, challengeId);

    expect(res.statusCode).toBe(200);
    expect(mocks.turnkey.verifyOtp).toHaveBeenCalledWith(
      expect.objectContaining({ otpId: "otp-1", encryptedOtpBundle: "encrypted-otp-bundle" }),
    );
    expect(mocks.turnkey.verifyOtp.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.turnkey.createSubOrganizationWithEmailWallet.mock.invocationCallOrder[0]!,
    );
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).toHaveBeenCalledWith(
      expect.objectContaining({ rootUser: expect.objectContaining({ userEmail: EMAIL }) }),
    );
    expect(mocks.pinVerifiedEmail).toHaveBeenCalledWith(expect.anything(), {
      appId: "app",
      resourceId: "new-resource",
      email: EMAIL,
    });
    expect(res.json()).toMatchObject({
      verificationToken: tokenFor(EMAIL),
      organizationId: "new-sub-org",
      walletId: "new-wallet",
      defaultAddress: "tb1p-new-address",
      authMethod: "email",
    });
    expect(res.json().externalUserId).toMatch(/^email-[0-9a-f-]{36}$/);
    expect(mocks.challenges.get(challengeId).status).toBe("consumed");
  });

  it("returns the email's pinned wallet on every later sign-in without creating another", async () => {
    const app = await buildServer();
    mocks.wallets.push(walletRow({ verified_email: EMAIL }));

    const res = await verify(app, (await signin(app)).json().challengeId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ organizationId: "victim-sub-org", externalUserId: "victim-external" });
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();
    expect(mocks.findEmailWalletByRecoveryEmail).not.toHaveBeenCalled();
    expect(mocks.pinVerifiedEmail).not.toHaveBeenCalled();
  });

  it("pins a wallet made before sign-in existed on its first verified sign-in", async () => {
    const app = await buildServer();
    const legacy = walletRow();
    mocks.wallets.push(legacy);
    mocks.findEmailWalletByRecoveryEmail.mockResolvedValueOnce(legacy);

    const res = await verify(app, (await signin(app)).json().challengeId);

    expect(res.statusCode).toBe(200);
    expect(res.json().organizationId).toBe("victim-sub-org");
    expect(legacy.verified_email).toBe(EMAIL);
    expect(mocks.findEmailWalletByRecoveryEmail).toHaveBeenCalledWith(expect.anything(), {
      appId: "app",
      email: EMAIL,
      rootOrganizationId: ROOT_ORG,
    });
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();
  });

  it("creates and reveals nothing for a wrong code", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    mocks.turnkey.verifyOtp.mockRejectedValueOnce(new Error("invalid otp"));

    const res = await verify(app, challengeId);

    expect(res.statusCode).toBe(401);
    expect(res.payload).not.toMatch(LEAK_PATTERN);
    expect(mocks.lockEmailWallets).not.toHaveBeenCalled();
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();
    expect(mocks.challenges.get(challengeId)).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("stops verifying after five attempts without touching the challenge's status", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    mocks.challenges.get(challengeId).attempts = 5;

    const res = await verify(app, challengeId);

    expect(res.statusCode).toBe(429);
    expect(mocks.turnkey.verifyOtp).not.toHaveBeenCalled();
    // A verify racing one that consumed the challenge is refused here too; it must not undo the consume.
    expect(mocks.challenges.get(challengeId).status).toBe("pending");
  });

  it("refuses a token Turnkey issued for a different email than the challenge", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    mocks.turnkey.verifyOtp.mockResolvedValueOnce({ verificationToken: tokenFor("other@example.com"), activityId: "a" });

    const res = await verify(app, challengeId);

    expect(res.statusCode).toBe(500);
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();
  });

  it("creates one wallet when sign-ins for the same new email verify at the same time", async () => {
    const app = await buildServer();
    const first = (await signin(app)).json().challengeId;
    const second = (await signin(app)).json().challengeId;
    mocks.turnkey.createSubOrganizationWithEmailWallet.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return mocks.created();
    });

    const [a, b] = await Promise.all([verify(app, first), verify(app, second)]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).toHaveBeenCalledTimes(1);
    expect(a.json().organizationId).toBe("new-sub-org");
    expect(b.json().organizationId).toBe("new-sub-org");
  });

  it("does not accept an /init challenge at /verify or /session", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    mocks.challenges.get(challengeId).otp_id = null;

    expect((await verify(app, challengeId)).statusCode).toBe(404);
    expect((await session(app, challengeId)).statusCode).toBe(401);
    expect(mocks.turnkey.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.turnkey.otpLogin).not.toHaveBeenCalled();
  });

  it("/session opens OTP_LOGIN_V2 in the verified wallet with the client's key and signature", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    await verify(app, challengeId);

    const res = await session(app, challengeId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session: "session-jwt", organizationId: "new-sub-org", expiresInSeconds: 3600 });
    expect(mocks.turnkey.otpLogin).toHaveBeenCalledWith({
      organizationId: "new-sub-org",
      verificationToken: tokenFor(EMAIL),
      publicKey: "02" + "ee".repeat(32),
      clientSignature: expect.objectContaining({ scheme: "CLIENT_SIGNATURE_SCHEME_API_P256" }),
      expirationSeconds: "3600",
    });
  });

  it("/session refuses a challenge whose code has not verified", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();

    const res = await session(app, challengeId);

    expect(res.statusCode).toBe(401);
    expect(mocks.turnkey.otpLogin).not.toHaveBeenCalled();
  });

  it("/session refuses a verified challenge once it has expired", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    await verify(app, challengeId);
    mocks.challenges.get(challengeId).expires_at = new Date(Date.now() - 1000).toISOString();

    const res = await session(app, challengeId);

    expect(res.statusCode).toBe(401);
    expect(mocks.turnkey.otpLogin).not.toHaveBeenCalled();
  });

  it("/session answers 401 when Turnkey refuses the token or signature", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    await verify(app, challengeId);
    mocks.turnkey.otpLogin.mockRejectedValueOnce(new Error("invalid client signature"));

    const res = await session(app, challengeId);

    expect(res.statusCode).toBe(401);
    expect(res.payload).not.toMatch(/session-jwt/);
  });
});

describe("email sign-in SQL", () => {
  const actual = () => vi.importActual<typeof import("../../db/queries.js")>("../../db/queries.js");

  it("counts only /signin's own challenges for its rate limit", async () => {
    const { countRecentChallenges } = await vi.importActual<typeof import("../../db/recovery.js")>("../../db/recovery.js");
    const query = vi.fn(async () => ({ rows: [{ count: "0" }] }));

    await countRecentChallenges({ query } as never, { appId: "a", emailHash: "h", windowMs: 1, signinOnly: true });
    await countRecentChallenges({ query } as never, { appId: "a", emailHash: "h", windowMs: 1 });

    const calls = query.mock.calls as unknown as Array<[string]>;
    expect(calls[0]![0]).toContain("AND otp_id IS NOT NULL");
    expect(calls[1]![0]).not.toContain("otp_id");
  });

  it("only falls back to a recovery-email wallet that is unpinned, app-scoped and its owner's sole credential", async () => {
    const { findEmailWalletByRecoveryEmail } = await actual();
    const query = vi.fn(async () => ({ rows: [] }));

    await findEmailWalletByRecoveryEmail({ query } as never, {
      appId: "app-a",
      email: " Victim@Example.com ",
      rootOrganizationId: ROOT_ORG,
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    const flat = sql.replace(/\s+/g, " ");
    expect(params).toEqual(["app-a", "victim@example.com", ROOT_ORG]);
    expect(flat).toMatch(/r\.app_id = \$1/);
    expect(flat).toMatch(/u\.app_id = \$1/);
    expect(flat).toContain("r.verified_email IS NULL");
    expect(flat).toContain("NOT EXISTS ( SELECT 1 FROM turnkey_resources o WHERE o.user_id = r.user_id AND o.id <> r.id )");
    expect(flat).toContain("NOT EXISTS (SELECT 1 FROM linked_wallets l WHERE l.user_id = r.user_id)");
  });

  it("looks the pinned wallet up by app and lowercased email", async () => {
    const { findEmailWalletByVerifiedEmail } = await actual();
    const query = vi.fn(async () => ({ rows: [] }));

    await findEmailWalletByVerifiedEmail({ query } as never, { appId: "app-a", email: " Victim@Example.com " });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["app-a", "victim@example.com"]);
    expect(sql).toMatch(/r\.app_id = \$1 AND r\.verified_email = \$2/);
  });

  it("never re-pins a wallet another email already signs in to", async () => {
    const { pinVerifiedEmail } = await actual();
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));

    await expect(
      pinVerifiedEmail({ query } as never, { appId: "app-a", resourceId: "r-1", email: "Victim@Example.com" }),
    ).rejects.toThrow(/already pinned/);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/verified_email IS NULL/);
    expect(params).toEqual(["r-1", "app-a", "victim@example.com"]);
  });
});
