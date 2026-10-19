import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decryptCredentialBundle,
  generateP256KeyPair,
  getPublicKey
} from "@turnkey/crypto";

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * App-store review login: the configured test email + static OTP opens
 * a single pre-provisioned dummy mainnet wallet without any Turnkey OTP
 * round-trip, and the verify response's credentialBundle round-trips
 * back to the stored review API key via the client's decrypt helper.
 */

// Deterministic review API key + a mainnet-looking address for the dummy
// sub-org. The private key is what the client should recover.
const reviewApiKey = generateP256KeyPair();
const REVIEW_PRIVATE_KEY_HEX = reviewApiKey.privateKey;
const REVIEW_PUBLIC_KEY_HEX = toHex(getPublicKey(REVIEW_PRIVATE_KEY_HEX, true));

const REVIEW_EMAIL = "play-review@arch.network";
const REVIEW_OTP = "424242";
const REVIEW_ORG = "sub-org-review";
const REVIEW_ROOT_USER = "root-user-review";
const REVIEW_WALLET = "wallet-review";
const REVIEW_ADDRESS = "bc1pdummyreviewwalletaddressxxxxxxxxxxxxxxxxxxxxxxxxxq9review";

// The Turnkey client must never be touched on the review path.
const mocks = vi.hoisted(() => ({
  turnkey: {
    initOtpAuth: vi.fn(),
    otpAuth: vi.fn()
  }
}));

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (
    _pool: unknown,
    cb: (client: unknown) => Promise<unknown>
  ) => cb({})
}));
vi.mock("../../audit/audit.js", () => ({ auditEvent: async () => undefined }));
vi.mock("../../turnkey/store.js", () => ({
  getTurnkeyClient: () => mocks.turnkey
}));

import { registerRecoveryRoutes } from "../recovery.js";

const reviewConfig = {
  REVIEW_LOGIN_ENABLED: true,
  REVIEW_LOGIN_EMAIL: REVIEW_EMAIL,
  REVIEW_LOGIN_OTP_CODE: REVIEW_OTP,
  REVIEW_LOGIN_ORGANIZATION_ID: REVIEW_ORG,
  REVIEW_LOGIN_ROOT_USER_ID: REVIEW_ROOT_USER,
  REVIEW_LOGIN_WALLET_ID: REVIEW_WALLET,
  REVIEW_LOGIN_DEFAULT_ADDRESS: REVIEW_ADDRESS,
  REVIEW_LOGIN_DEFAULT_PUBLIC_KEY_HEX: "02" + "cd".repeat(32),
  REVIEW_LOGIN_EXTERNAL_USER_ID: "ext-review",
  REVIEW_LOGIN_API_PRIVATE_KEY_HEX: REVIEW_PRIVATE_KEY_HEX,
  TURNKEY_ORGANIZATION_ID: "root-org"
} as never;

async function buildServer(config: unknown = reviewConfig) {
  const app = Fastify();
  app.decorate("config", config as never);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerRecoveryRoutes, { prefix: "/v1" });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof buildServer>>;

const init = (app: App, email = REVIEW_EMAIL) =>
  app.inject({
    method: "POST",
    url: "/v1/recovery/email/init",
    payload: { email }
  });

const start = (
  app: App,
  challengeId: string,
  candidateToken: string,
  email = REVIEW_EMAIL
) =>
  app.inject({
    method: "POST",
    url: "/v1/recovery/email/start",
    payload: { challengeId, candidateToken, email }
  });

const verify = (
  app: App,
  challengeId: string,
  candidateToken: string,
  code: string,
  ephemeralPublicKey: string
) =>
  app.inject({
    method: "POST",
    url: "/v1/recovery/email/verify",
    payload: { challengeId, candidateToken, code, ephemeralPublicKey }
  });

describe("app-store review login", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("init returns a single synthetic candidate without touching Turnkey", async () => {
    const app = await buildServer();
    const res = await init(app);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challengeId).toMatch(/^chal_review_[0-9a-f]{32}$/);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].authMethod).toBe("email");
    expect(body.candidates[0].isCustodial).toBe(false);
    // Full address must never be leaked pre-verify.
    expect(body.candidates[0].addressMasked).not.toBe(REVIEW_ADDRESS);
    expect(body.emailMasked).toContain("@arch.network");
    expect(mocks.turnkey.initOtpAuth).not.toHaveBeenCalled();
    await app.close();
  });

  it("completes init -> start -> verify and returns a decryptable bundle", async () => {
    const app = await buildServer();

    const initRes = await init(app);
    const { challengeId, candidates } = initRes.json();
    const candidateToken = candidates[0].candidateToken;

    const startRes = await start(app, challengeId, candidateToken);
    expect(startRes.statusCode).toBe(200);
    expect(mocks.turnkey.initOtpAuth).not.toHaveBeenCalled();

    // Client generates an ephemeral keypair; the bundle is sealed to it.
    const ephemeral = generateP256KeyPair();
    const verifyRes = await verify(
      app,
      challengeId,
      candidateToken,
      REVIEW_OTP,
      ephemeral.publicKeyUncompressed
    );
    expect(verifyRes.statusCode).toBe(200);
    const body = verifyRes.json();
    expect(body.organizationId).toBe(REVIEW_ORG);
    expect(body.rootUserId).toBe(REVIEW_ROOT_USER);
    expect(body.walletId).toBe(REVIEW_WALLET);
    expect(body.defaultAddress).toBe(REVIEW_ADDRESS);
    expect(body.authMethod).toBe("email");
    expect(mocks.turnkey.otpAuth).not.toHaveBeenCalled();

    // The client decrypts the bundle to the stored review API key.
    const recoveredHex = decryptCredentialBundle(
      body.credentialBundle,
      ephemeral.privateKey
    );
    expect(recoveredHex).toBe(REVIEW_PRIVATE_KEY_HEX);
    const recoveredPub = toHex(getPublicKey(recoveredHex, true));
    expect(recoveredPub).toBe(REVIEW_PUBLIC_KEY_HEX);

    await app.close();
  });

  it("rejects a wrong OTP code with 401 and no bundle", async () => {
    const app = await buildServer();
    const { challengeId, candidates } = (await init(app)).json();
    const ephemeral = generateP256KeyPair();
    const res = await verify(
      app,
      challengeId,
      candidates[0].candidateToken,
      "000000",
      ephemeral.publicKeyUncompressed
    );
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a forged candidate token with 400", async () => {
    const app = await buildServer();
    const { challengeId } = (await init(app)).json();
    const ephemeral = generateP256KeyPair();
    const res = await verify(
      app,
      challengeId,
      "not-the-real-token",
      REVIEW_OTP,
      ephemeral.publicKeyUncompressed
    );
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a malformed ephemeral public key with 400", async () => {
    const app = await buildServer();
    const { challengeId, candidates } = (await init(app)).json();
    const res = await verify(
      app,
      challengeId,
      candidates[0].candidateToken,
      REVIEW_OTP,
      "04deadbeef"
    );
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("start rejects a mismatched recovery email with 400", async () => {
    const app = await buildServer();
    const { challengeId, candidates } = (await init(app)).json();
    const res = await start(
      app,
      challengeId,
      candidates[0].candidateToken,
      "attacker@example.com"
    );
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
