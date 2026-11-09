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

/** A verification token as Turnkey issues it: `exp` a millisecond-epoch string (@turnkey/crypto's VerificationTokenClaims). */
function tokenFor(contact: string, id = "token-1", exp: string | number = "4102444800000"): string {
  const claims = { contact, exp, id, public_key: "02" + "ee".repeat(32), verification_type: "OTP_TYPE_EMAIL" };
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
    createPerson: vi.fn(async (_c: unknown, _p: any) => ({ id: "new-user", external_user_id: "usr_" + "0".repeat(32) })),
    getPersonByVerifiedEmail: vi.fn(async (_c: unknown, _p: any): Promise<any> => null),
    listTurnkeyResourcesForUserForApp: vi.fn(async (_c: unknown, p: { userId: string }) => wallets.filter((w) => w.user_id === p.userId)),
    insertIdentity: vi.fn(async () => null),
    getIdentity: vi.fn(async (): Promise<any> => null),
    claimEmailIdentity: vi.fn(async (): Promise<{ ok: true } | { ok: false; ownerUserId: string }> => ({ ok: true })),
    getPerson: vi.fn(async (_c: unknown, p: { userId: string }) => ({
      id: p.userId,
      external_user_id: p.userId === "new-user" ? "usr_" + "0".repeat(32) : `ext-${p.userId}`,
      primary_email: EMAIL,
      email_verified_at: "2026-11-06T00:00:00Z",
    })),
    mintSessionForUser: vi.fn(async () => ({ token: "whs_v1_test", sessionId: "s-1", expiresAt: "2026-11-07T00:00:00.000Z" })),
    mintIdentityToken: vi.fn(async () => ({ token: "id-token", expiresAt: "2026-11-06T00:15:00.000Z" })),
    setVerifiedPrimaryEmail: vi.fn(async () => true),
    auditEvent: vi.fn(async () => undefined),
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
        const row = challenges.get(p.id);
        row.status = p.status;
        if (p.expiresAt) row.expires_at = new Date(p.expiresAt).toISOString();
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
vi.mock("../../audit/audit.js", () => ({ auditEvent: mocks.auditEvent }));
vi.mock("../../turnkey/store.js", () => ({ getTurnkeyClient: () => mocks.turnkey }));
vi.mock("../../db/identities.js", async (orig) => ({
  ...(await orig<typeof import("../../db/identities.js")>()),
  createPerson: mocks.createPerson,
  getPersonByVerifiedEmail: mocks.getPersonByVerifiedEmail,
  insertIdentity: mocks.insertIdentity,
  getIdentity: mocks.getIdentity,
  claimEmailIdentity: mocks.claimEmailIdentity,
  getPerson: mocks.getPerson,
  setVerifiedPrimaryEmail: mocks.setVerifiedPrimaryEmail,
}));
vi.mock("../../auth/sessionToken.js", () => ({ mintSessionForUser: mocks.mintSessionForUser }));
vi.mock("../../auth/idToken.js", () => ({ mintIdentityToken: mocks.mintIdentityToken }));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  findEmailWalletByVerifiedEmail: mocks.findEmailWalletByVerifiedEmail,
  findEmailWalletByRecoveryEmail: mocks.findEmailWalletByRecoveryEmail,
  pinVerifiedEmail: mocks.pinVerifiedEmail,
  insertTurnkeyResource: mocks.insertTurnkeyResource,
  listTurnkeyResourcesForUserForApp: mocks.listTurnkeyResourcesForUserForApp,
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
  app.decorate("idTokenSigner", {} as never);
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

const sessionWith = (app: App, challengeId: string, verificationToken: string) =>
  app.inject({
    method: "POST",
    url: "/v1/recovery/email/signin/session",
    payload: {
      challengeId,
      verificationToken,
      publicKey: "02" + "ee".repeat(32),
      clientSignature: {
        scheme: "CLIENT_SIGNATURE_SCHEME_API_P256",
        publicKey: "02" + "ee".repeat(32),
        message: '{"login":{"publicKey":"02ee"},"tokenId":"token-1","type":"USAGE_TYPE_LOGIN"}',
        signature: "ab".repeat(64),
      },
    },
  });

const session = (app: App, challengeId: string) => sessionWith(app, challengeId, tokenFor(EMAIL));

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
    expect(res.json().externalUserId).toMatch(/^usr_[0-9a-f]{32}$/);
    expect(mocks.createPerson).toHaveBeenCalledWith(expect.anything(), { appId: "app", email: EMAIL, emailVerified: true });
    expect(mocks.claimEmailIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "new-user", email: EMAIL }),
    );
    expect(mocks.challenges.get(challengeId).expires_at).toBe(new Date(4102444800 * 1000).toISOString());
    expect(mocks.challenges.get(challengeId).candidates[0].verificationTokenId).toBe("token-1");
    expect(mocks.setVerifiedPrimaryEmail).toHaveBeenCalledWith(expect.anything(), { appId: "app", userId: "new-user", email: EMAIL });
    expect(res.json()).toMatchObject({
      sessionToken: "whs_v1_test",
      sessionExpiresAt: "2026-11-07T00:00:00.000Z",
      idToken: "id-token",
      idTokenExpiresAt: "2026-11-06T00:15:00.000Z",
      email: EMAIL,
      emailVerified: true,
    });
    expect(mocks.mintSessionForUser).toHaveBeenCalledWith(expect.anything(), { appId: "app", userId: "new-user" });
    expect(mocks.mintIdentityToken).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      appId: "app",
      userId: "new-user",
      externalUserId: "usr_" + "0".repeat(32),
      email: EMAIL,
      emailVerified: true,
      amr: ["email"],
    });
    expect(mocks.challenges.get(challengeId).status).toBe("consumed");
  });

  it("signs in to the wallet of the person a Google sign-up already verified the email on", async () => {
    const app = await buildServer();
    const google = walletRow({ id: "google-resource", user_id: "google-user", organization_id: "google-sub-org", auth_method: "oauth" });
    mocks.wallets.push(google);
    mocks.getPersonByVerifiedEmail.mockResolvedValueOnce({ id: "google-user", external_user_id: "usr_google" });

    const res = await verify(app, (await signin(app)).json().challengeId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ organizationId: "google-sub-org", externalUserId: "usr_google" });
    expect(google.verified_email).toBe(EMAIL);
    expect(mocks.findEmailWalletByRecoveryEmail).not.toHaveBeenCalled();
    expect(mocks.createPerson).not.toHaveBeenCalled();
    expect(mocks.turnkey.createSubOrganizationWithEmailWallet).not.toHaveBeenCalled();
  });

  it("creates an email wallet for a verified person whose only wallet is a passkey", async () => {
    const app = await buildServer();
    const passkey = walletRow({
      id: "passkey-resource",
      user_id: "passkey-user",
      organization_id: "passkey-sub-org",
      auth_method: "passkey",
    });
    mocks.wallets.push(passkey);
    mocks.getPersonByVerifiedEmail.mockResolvedValueOnce({ id: "passkey-user", external_user_id: "usr_passkey" });

    const res = await verify(app, (await signin(app)).json().challengeId);

    expect(res.statusCode).toBe(200);
    expect(passkey.verified_email).toBeNull();
    expect(mocks.createPerson).not.toHaveBeenCalled();
    expect(mocks.insertTurnkeyResource).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "passkey-user", authMethod: "email" }),
    );
    expect(res.json().organizationId).toBe("new-sub-org");
  });

  it("signs in to the person who already has a verified email identity when primary email does not say so", async () => {
    const app = await buildServer();
    const identified = walletRow({
      id: "ident-resource",
      user_id: "ident-user",
      organization_id: "ident-sub-org",
      auth_method: "oauth",
    });
    mocks.wallets.push(identified);
    mocks.getIdentity.mockResolvedValueOnce({
      user_id: "ident-user",
      verified_at: "2026-01-01T00:00:00Z",
      kind: "email",
      subject: EMAIL,
    });

    const res = await verify(app, (await signin(app)).json().challengeId);

    expect(res.statusCode).toBe(200);
    expect(res.json().organizationId).toBe("ident-sub-org");
    expect(mocks.createPerson).not.toHaveBeenCalled();
    expect(mocks.findEmailWalletByRecoveryEmail).not.toHaveBeenCalled();
    expect(mocks.claimEmailIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "ident-user", email: EMAIL }),
    );
  });

  it("does not treat an unverified recovery-email identity as the owner", async () => {
    const app = await buildServer();
    mocks.getIdentity.mockResolvedValueOnce({
      user_id: "squatter",
      verified_at: null,
      kind: "email",
      subject: EMAIL,
    });

    const res = await verify(app, (await signin(app)).json().challengeId);

    expect(res.statusCode).toBe(200);
    expect(mocks.createPerson).toHaveBeenCalled();
    expect(mocks.claimEmailIdentity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "new-user" }),
    );
  });

  it("rolls back a new pin when the verified email belongs to someone else", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    mocks.claimEmailIdentity.mockResolvedValueOnce({ ok: false, ownerUserId: "other-user" });

    const res = await verify(app, challengeId);

    expect(res.statusCode).toBe(500);
    expect(mocks.challenges.get(challengeId).status).toBe("pending");
    expect(mocks.mintSessionForUser).not.toHaveBeenCalled();
    expect(mocks.mintIdentityToken).not.toHaveBeenCalled();
  });

  it("audits a Turnkey sub-org left behind when the pin transaction rolls back", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    mocks.insertTurnkeyResource.mockRejectedValueOnce(new Error("db down"));

    const res = await verify(app, challengeId);

    expect(res.statusCode).toBe(500);
    expect(mocks.challenges.get(challengeId).status).toBe("pending");
    expect(mocks.auditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "failed",
        payloadJson: expect.objectContaining({
          reason: "suborg_orphaned",
          subOrganizationId: "new-sub-org",
          walletId: "new-wallet",
        }),
      }),
    );
  });

  it("makes a wallet for the verified person who has none, without a second person", async () => {
    const app = await buildServer();
    mocks.getPersonByVerifiedEmail.mockResolvedValueOnce({ id: "residue-user", external_user_id: "usr_residue" });

    const res = await verify(app, (await signin(app)).json().challengeId);

    expect(res.statusCode).toBe(200);
    expect(res.json().externalUserId).toBe("usr_residue");
    expect(mocks.createPerson).not.toHaveBeenCalled();
    expect(mocks.insertTurnkeyResource).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "residue-user" }));
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
    expect(mocks.mintSessionForUser).not.toHaveBeenCalled();
    expect(mocks.mintIdentityToken).not.toHaveBeenCalled();
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

  it("reads Turnkey's millisecond-string exp, and a numeric one as seconds", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    expect((await verify(app, challengeId)).statusCode).toBe(200);

    mocks.turnkey.verifyOtp.mockResolvedValueOnce({ verificationToken: tokenFor(EMAIL, "token-2", 4102444800), activityId: "a" });
    const again = (await signin(app)).json();
    expect((await verify(app, again.challengeId)).statusCode).toBe(200);
  });

  it("/session refuses a token whose millisecond exp has passed", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    await verify(app, challengeId);

    const lapsed = await sessionWith(app, challengeId, tokenFor(EMAIL, "token-1", String(Date.now() - 1000)));

    expect(lapsed.statusCode).toBe(401);
    expect(mocks.turnkey.otpLogin).not.toHaveBeenCalled();
  });

  it("/session refuses a token for a different email or a different verification", async () => {
    const app = await buildServer();
    const { challengeId } = (await signin(app)).json();
    await verify(app, challengeId);

    const otherEmail = await sessionWith(app, challengeId, tokenFor("other@example.com"));
    expect(otherEmail.statusCode).toBe(401);
    expect(mocks.turnkey.otpLogin).not.toHaveBeenCalled();

    const swapped = await sessionWith(app, challengeId, tokenFor(EMAIL, "token-2"));
    expect(swapped.statusCode).toBe(401);
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
    expect(sql).toMatch(/r\.app_id = \$1 AND lower\(r\.verified_email\) = \$2/);
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

  it("keeps a consumed challenge open until the verification token expires", async () => {
    const { markRecoveryChallengeStatus } = await vi.importActual<typeof import("../../db/recovery.js")>("../../db/recovery.js");
    const query = vi.fn(async () => ({ rows: [] }));
    const expiresAt = new Date("2100-01-01T00:00:00.000Z");

    await markRecoveryChallengeStatus({ query } as never, { id: "c-1", status: "consumed", expiresAt });

    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("expires_at = COALESCE($3::timestamptz, expires_at)");
    expect(params).toEqual(["c-1", "consumed", expiresAt]);
  });
});
