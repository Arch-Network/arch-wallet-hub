import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashEmailForRateLimit,
  otpUserIdentifier,
  type RecoveryChallengeRow
} from "../../db/recovery.js";

/**
 * Email-OTP recovery: verify attempts are budgeted per challenge (a
 * resend does not reset them), and every INIT_OTP_AUTH carries a stable
 * hashed `userIdentifier` so Turnkey's per-user OTP limits apply.
 */

const EMAIL = "user@example.com";
const CHALLENGE_ID = "challenge-1";
const TOKEN = "candidate-token-1";

const mocks = vi.hoisted(() => {
  const state = { row: null as RecoveryChallengeRow | null, otpCount: 0 };
  const clone = () => (state.row ? structuredClone(state.row) : null);
  return {
    state,
    getRecoveryChallenge: vi.fn(async () => clone()),
    getRecoveryChallengeForUpdate: vi.fn(async () => clone()),
    updateRecoveryChallengeCandidates: vi.fn(async (_c: unknown, p: any) => {
      state.row!.candidates = structuredClone(p.candidates);
      return clone();
    }),
    markRecoveryChallengeStatus: vi.fn(async (_c: unknown, p: any) => {
      state.row!.status = p.status;
    }),
    incrementRecoveryAttemptIfUnderCap: vi.fn(async (_c: unknown, p: any) => {
      const row = state.row;
      if (!row || row.status !== "pending" || row.attempts >= p.maxAttempts) return null;
      row.attempts += 1;
      return clone();
    }),
    turnkey: {
      initOtpAuth: vi.fn(async (_p: any) => ({
        otpId: `otp-${++state.otpCount}`,
        activityId: `activity-${state.otpCount}`,
        submitElapsedMs: 0,
        pollElapsedMs: 0,
        pollAttempts: 0
      })),
      otpAuth: vi.fn(async (): Promise<any> => {
        throw new Error("Turnkey otpAuth did not complete");
      })
    }
  };
});

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({})
}));
vi.mock("../../audit/audit.js", () => ({ auditEvent: async () => undefined }));
vi.mock("../../turnkey/store.js", () => ({ getTurnkeyClient: () => mocks.turnkey }));
vi.mock("../../db/recovery.js", async (orig) => ({
  ...(await orig<typeof import("../../db/recovery.js")>()),
  getRecoveryChallenge: mocks.getRecoveryChallenge,
  getRecoveryChallengeForUpdate: mocks.getRecoveryChallengeForUpdate,
  updateRecoveryChallengeCandidates: mocks.updateRecoveryChallengeCandidates,
  markRecoveryChallengeStatus: mocks.markRecoveryChallengeStatus,
  incrementRecoveryAttemptIfUnderCap: mocks.incrementRecoveryAttemptIfUnderCap
}));

import { registerRecoveryRoutes } from "../recovery.js";

async function buildServer() {
  const app = Fastify();
  app.decorate("config", {} as never);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerRecoveryRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

function seedChallenge() {
  mocks.state.otpCount = 0;
  mocks.state.row = {
    id: CHALLENGE_ID,
    app_id: "app",
    email_hash: hashEmailForRateLimit(EMAIL),
    candidates: [
      {
        candidateToken: TOKEN,
        resourceId: "resource-1",
        userId: "user-1",
        externalUserId: "ext-1",
        organizationId: "sub-org-1",
        rootUserId: "root-user-1",
        otpId: null,
        walletLabel: "Wallet",
        addressMasked: "tb1p...abcd",
        walletId: "wallet-1",
        defaultAddress: "tb1p-addr",
        defaultPublicKeyHex: "02" + "aa".repeat(32),
        createdAt: "2026-01-01T00:00:00Z",
        authMethod: "email"
      }
    ],
    status: "pending",
    attempts: 0,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    consumed_at: null
  };
}

/** Move the latest OTP send outside the resend cooldown. */
function ageLatestOtp() {
  mocks.state.row!.candidates[0]!.otpStartedAt = new Date(Date.now() - 60_000).toISOString();
}

type App = Awaited<ReturnType<typeof buildServer>>;

const start = (app: App, email = EMAIL) =>
  app.inject({
    method: "POST",
    url: "/v1/recovery/email/start",
    payload: { challengeId: CHALLENGE_ID, candidateToken: TOKEN, email }
  });

const verify = (app: App) =>
  app.inject({
    method: "POST",
    url: "/v1/recovery/email/verify",
    payload: {
      challengeId: CHALLENGE_ID,
      candidateToken: TOKEN,
      code: "000000",
      ephemeralPublicKey: "04" + "bb".repeat(64)
    }
  });

describe("email OTP verify attempts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedChallenge();
  });

  it("does not reset attempts on resend, and refuses once the challenge budget is spent", async () => {
    const app = await buildServer();

    expect((await start(app)).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) expect((await verify(app)).statusCode).toBe(401);
    expect(mocks.state.row!.attempts).toBe(3);

    ageLatestOtp();
    expect((await start(app)).statusCode).toBe(200);
    expect(mocks.state.row!.candidates[0]!.otpId).toBe("otp-2");
    expect(mocks.state.row!.attempts).toBe(3);

    for (let i = 0; i < 2; i++) expect((await verify(app)).statusCode).toBe(401);
    expect(mocks.state.row!.attempts).toBe(5);

    const exhausted = await verify(app);
    expect(exhausted.statusCode).toBe(429);
    expect(exhausted.json().message).toBe("Too many verification attempts");
    expect(mocks.state.row!.status).toBe("failed");
    expect(mocks.turnkey.otpAuth).toHaveBeenCalledTimes(5);

    // The challenge is dead: a resend or another guess is refused and the
    // client has to start over from /init.
    ageLatestOtp();
    expect((await start(app)).statusCode).toBe(410);
    expect((await verify(app)).statusCode).toBe(410);
    expect(mocks.turnkey.initOtpAuth).toHaveBeenCalledTimes(2);
    expect(mocks.turnkey.otpAuth).toHaveBeenCalledTimes(5);

    await app.close();
  });
});

describe("INIT_OTP_AUTH userIdentifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedChallenge();
  });

  it("sends the same hashed identifier on every send for the same email", async () => {
    const app = await buildServer();
    expect((await start(app)).statusCode).toBe(200);
    ageLatestOtp();
    expect((await start(app, "USER@Example.com")).statusCode).toBe(200);
    await app.close();

    const sent = mocks.turnkey.initOtpAuth.mock.calls.map(([p]) => p.userIdentifier);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(sent[0]).toBe(otpUserIdentifier("app", EMAIL));
    expect(sent[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(sent[0]).not.toContain("example");
  });

  it("is scoped per app and per normalised email", () => {
    expect(otpUserIdentifier("app", " User@Example.COM ")).toBe(otpUserIdentifier("app", EMAIL));
    expect(otpUserIdentifier("other-app", EMAIL)).not.toBe(otpUserIdentifier("app", EMAIL));
    expect(otpUserIdentifier("app", "other@example.com")).not.toBe(otpUserIdentifier("app", EMAIL));
    // Not the existing rate-limit hash, so it cannot be joined against it.
    expect(otpUserIdentifier("app", EMAIL)).not.toBe(hashEmailForRateLimit(EMAIL));
  });
});
