import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashEmailForRateLimit, type RecoveryChallengeRow } from "../../db/recovery.js";

/**
 * POST /v1/recovery/email/verify success attests the person: the recovery
 * email becomes a verified email identity and primary email, a Hub session
 * opens and an Arch ID token with amr ["email"] is minted. Turnkey and the
 * DB helpers are mocked at the function level, as in authOAuth.test.ts.
 */

const EMAIL = "jonah@arch.network";
/** users.recovery_email keeps the raw casing; the challenge hash and the identity subject normalise it. */
const STORED_EMAIL = "Jonah@Arch.Network";
const CHALLENGE_ID = "challenge-1";
const TOKEN = "candidate-token-1";
const USER_ID = "user-1";
const EXTERNAL_ID = "usr_0123456789abcdef0123456789abcdef";
const WALLET_KEY = "02" + "cd".repeat(32);
const ISSUER = "https://hub.test";

const mocks = vi.hoisted(() => {
  const state = {
    row: null as RecoveryChallengeRow | null,
    person: null as Record<string, unknown> | null,
  };
  const clone = () => (state.row ? structuredClone(state.row) : null);
  return {
    state,
    getRecoveryChallenge: vi.fn(async () => clone()),
    markRecoveryChallengeStatus: vi.fn(async (_c: unknown, p: any) => {
      state.row!.status = p.status;
    }),
    incrementRecoveryAttemptIfUnderCap: vi.fn(async () => {
      state.row!.attempts += 1;
      return clone();
    }),
    getPerson: vi.fn(async () => (state.person ? { ...state.person } : null)),
    insertIdentity: vi.fn(async (_c: unknown, p: any): Promise<any> => ({ id: "ident", ...p, user_id: p.userId, verified_at: "2026-10-30T00:00:00.000Z" })),
    setVerifiedPrimaryEmail: vi.fn(async (_c: unknown, p: any) => {
      state.person!.primary_email ??= p.email;
      state.person!.email_verified_at ??= "2026-10-30T00:00:00.000Z";
    }),
    listWalletPubkeysForUser: vi.fn(async () => [WALLET_KEY]),
    mintSessionForUser: vi.fn(async () => ({ token: "whs_v1_test", sessionId: "s-1", expiresAt: "2030-01-01T00:00:00.000Z" })),
    auditEvent: vi.fn(async (_p: any) => undefined),
    turnkey: {
      otpAuth: vi.fn(async () => ({ credentialBundle: "bundle", activityId: "act-1", apiKeyId: "key-1" })),
    },
  };
});

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
}));
vi.mock("../../audit/audit.js", () => ({ auditEvent: mocks.auditEvent }));
vi.mock("../../turnkey/store.js", () => ({ getTurnkeyClient: () => mocks.turnkey }));
vi.mock("../../db/recovery.js", async (orig) => ({
  ...(await orig<typeof import("../../db/recovery.js")>()),
  getRecoveryChallenge: mocks.getRecoveryChallenge,
  markRecoveryChallengeStatus: mocks.markRecoveryChallengeStatus,
  incrementRecoveryAttemptIfUnderCap: mocks.incrementRecoveryAttemptIfUnderCap,
}));
vi.mock("../../db/identities.js", async (orig) => ({
  ...(await orig<typeof import("../../db/identities.js")>()),
  getPerson: mocks.getPerson,
  insertIdentity: mocks.insertIdentity,
  setVerifiedPrimaryEmail: mocks.setVerifiedPrimaryEmail,
  listWalletPubkeysForUser: mocks.listWalletPubkeysForUser,
}));
vi.mock("../../auth/sessionToken.js", async (orig) => ({
  ...(await orig<typeof import("../../auth/sessionToken.js")>()),
  mintSessionForUser: mocks.mintSessionForUser,
}));

import { createIdTokenSigner, jwksDocument, verifyIdToken } from "../../auth/idToken.js";
import { registerRecoveryRoutes } from "../recovery.js";

const signer = createIdTokenSigner({ issuer: ISSUER, privateJwkJson: undefined, allowEphemeral: true });

async function buildServer() {
  const app = Fastify();
  app.decorate("config", {} as never);
  app.decorate("idTokenSigner", signer);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerRecoveryRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

function seed() {
  mocks.state.row = {
    id: CHALLENGE_ID,
    app_id: "app",
    email_hash: hashEmailForRateLimit(EMAIL),
    candidates: [
      {
        candidateToken: TOKEN,
        resourceId: "resource-1",
        userId: USER_ID,
        externalUserId: EXTERNAL_ID,
        organizationId: "sub-org-1",
        rootUserId: "root-user-1",
        otpId: "otp-1",
        walletLabel: "Wallet",
        addressMasked: "tb1p...abcd",
        walletId: "wallet-1",
        defaultAddress: "tb1p-addr",
        defaultPublicKeyHex: WALLET_KEY,
        createdAt: "2026-01-01T00:00:00Z",
        authMethod: "email",
      },
    ],
    status: "pending",
    attempts: 0,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    consumed_at: null,
  };
  mocks.state.person = {
    id: USER_ID,
    external_user_id: EXTERNAL_ID,
    primary_email: null,
    email_verified_at: null,
    recovery_email: STORED_EMAIL,
    created_at: "2026-01-01T00:00:00Z",
  };
}

const verify = async () => {
  const app = await buildServer();
  const res = await app.inject({
    method: "POST",
    url: "/v1/recovery/email/verify",
    payload: { challengeId: CHALLENGE_ID, candidateToken: TOKEN, code: "000000", ephemeralPublicKey: "04" + "bb".repeat(64) },
  });
  await app.close();
  return res;
};

describe("POST /v1/recovery/email/verify attests the person", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed();
  });

  it("verifies the email identity and primary email, opens a session and mints an ID token with amr email", async () => {
    const res = await verify();
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toMatchObject({
      credentialBundle: "bundle",
      externalUserId: EXTERNAL_ID,
      sessionToken: "whs_v1_test",
      sessionExpiresAt: "2030-01-01T00:00:00.000Z",
      email: STORED_EMAIL,
      emailVerified: true,
    });
    expect(typeof json.idTokenExpiresAt).toBe("string");

    const payload = verifyIdToken(json.idToken, jwksDocument(signer), ISSUER);
    expect(payload).toMatchObject({ sub: EXTERNAL_ID, email: STORED_EMAIL, email_verified: true, wallets: [WALLET_KEY], amr: ["email"] });

    expect(mocks.insertIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.insertIdentity.mock.calls[0]![1]).toEqual({
      appId: "app", userId: USER_ID, kind: "email", subject: EMAIL, issuer: null, audience: null, emailAtLink: STORED_EMAIL, verified: true,
    });
    expect(mocks.setVerifiedPrimaryEmail).toHaveBeenCalledWith({}, { appId: "app", userId: USER_ID, email: STORED_EMAIL });
    expect(mocks.mintSessionForUser).toHaveBeenCalledWith({}, { appId: "app", userId: USER_ID });
    expect(mocks.state.row!.status).toBe("consumed");
    expect(mocks.auditEvent.mock.calls.some((c) => (c[0] as any).outcome === "succeeded" && (c[0] as any).payloadJson.sessionId === "s-1")).toBe(true);
  });

  it("leaves an email identity another user owns alone and answers emailVerified false, still opening the session", async () => {
    mocks.insertIdentity.mockResolvedValueOnce(null);
    const res = await verify();
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json).toMatchObject({ sessionToken: "whs_v1_test", email: STORED_EMAIL, emailVerified: false });
    expect(mocks.setVerifiedPrimaryEmail).not.toHaveBeenCalled();
    expect(mocks.state.person!.email_verified_at).toBeNull();
    const payload = verifyIdToken(json.idToken, jwksDocument(signer), ISSUER);
    expect(payload).toMatchObject({ sub: EXTERNAL_ID, email: STORED_EMAIL, email_verified: false, amr: ["email"] });
  });

  it("attests nothing when recovery_email no longer hashes to the challenge's binding", async () => {
    mocks.state.person!.recovery_email = "rewritten@example.com";
    const res = await verify();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionToken: "whs_v1_test", email: null, emailVerified: false });
    expect(mocks.insertIdentity).not.toHaveBeenCalled();
    expect(mocks.setVerifiedPrimaryEmail).not.toHaveBeenCalled();
  });

  it("does not attest when Turnkey refuses the code", async () => {
    mocks.turnkey.otpAuth.mockRejectedValueOnce(new Error("OTP mismatch"));
    const res = await verify();
    expect(res.statusCode).toBe(401);
    expect(mocks.insertIdentity).not.toHaveBeenCalled();
    expect(mocks.mintSessionForUser).not.toHaveBeenCalled();
  });
});
