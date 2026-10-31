import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /v1/auth/oauth: sign-in, sign-up, the verified-email collision, a
 * replayed token, and the session + ID token every success returns.
 * The OIDC verifier and Turnkey are mocked; the DB helpers are mocked at
 * the function level like the other route suites.
 */

const ROOT_ORG = "root-org";
const SUB_ORG = "sub-org-google";
const SESSION_KEY = "0394e549c71fa99dd5cf752fba623090be314949b74e4cdf7ca72031dd638e281a";
const WALLET_KEY = "02" + "cd".repeat(32);

const claims = (overrides: Record<string, unknown> = {}) => ({
  provider: "google" as const,
  issuer: "https://accounts.google.com",
  subject: "goog-sub-1",
  audience: "client-1",
  email: "jonah@arch.network",
  emailVerified: true,
  name: "Jonah",
  expiresAt: new Date(Date.now() + 3600_000),
  tokenHash: "hash-1",
  ...overrides,
});

const mocks = vi.hoisted(() => ({
  verifyOidcToken: vi.fn(async (): Promise<any> => undefined),
  recordOidcTokenUse: vi.fn(async () => ({ replayed: false })),
  getIdentity: vi.fn(async (): Promise<any> => null),
  getPerson: vi.fn(async (): Promise<any> => null),
  getPersonByVerifiedEmail: vi.fn(async (): Promise<any> => null),
  createPerson: vi.fn(async (): Promise<any> => ({ id: "user-new", external_user_id: "usr_new", primary_email: "jonah@arch.network", email_verified_at: "2026-01-01", recovery_email: "jonah@arch.network", created_at: "2026-01-01" })),
  insertIdentity: vi.fn(async (_c: unknown, p: any) => ({ id: "ident", ...p })),
  listIdentitiesForUser: vi.fn(async () => []),
  listWalletPubkeysForUser: vi.fn(async () => [WALLET_KEY]),
  setVerifiedPrimaryEmail: vi.fn(async () => undefined),
  touchIdentityLogin: vi.fn(async () => undefined),
  listTurnkeyResourcesForUserForApp: vi.fn(async (): Promise<any[]> => []),
  insertTurnkeyResource: vi.fn(async (_c: unknown, p: any) => ({ id: "res-new", app_id: "app", user_id: p.userId, organization_id: p.organizationId, turnkey_root_user_id: p.turnkeyRootUserId, wallet_id: p.walletId, default_address: p.defaultAddress, default_public_key_hex: p.defaultPublicKeyHex, auth_method: p.authMethod, key_verified_at: "2026-01-01", created_at: "2026-01-01" })),
  mintSessionForUser: vi.fn(async () => ({ token: "whs_v1_test", sessionId: "s-1", expiresAt: "2030-01-01T00:00:00.000Z" })),
  auditEvent: vi.fn(async (_p: any) => undefined),
  turnkey: {
    createSubOrganizationWithOAuthWallet: vi.fn(async (_p: any) => ({ subOrganizationId: SUB_ORG, rootUserId: "root-1", walletId: "wallet-1", addresses: ["tb1p-new"], activityId: "act-create" })),
    getWalletAccountsForOrganization: vi.fn(async (_p: any) => ({ accounts: [{ walletAccountId: "wa", walletId: "wallet-1", address: "tb1p-new", publicKey: WALLET_KEY }] })),
    oauthLogin: vi.fn(async (_p: any) => ({ session: "jwt", activityId: "act-login" })),
  },
}));

vi.mock("../../db/pool.js", () => ({ getDbPool: () => ({}) }));
vi.mock("../../db/tx.js", () => ({
  withDbTransaction: async (_pool: unknown, cb: (client: unknown) => Promise<unknown>) => cb({}),
}));
vi.mock("../../audit/audit.js", () => ({ auditEvent: mocks.auditEvent }));
vi.mock("../../turnkey/store.js", () => ({ getTurnkeyClient: () => mocks.turnkey }));
vi.mock("../../auth/oidc.js", async (orig) => ({
  ...(await orig<typeof import("../../auth/oidc.js")>()),
  verifyOidcToken: mocks.verifyOidcToken,
}));
vi.mock("../../db/identities.js", async (orig) => ({
  ...(await orig<typeof import("../../db/identities.js")>()),
  recordOidcTokenUse: mocks.recordOidcTokenUse,
  getIdentity: mocks.getIdentity,
  getPerson: mocks.getPerson,
  getPersonByVerifiedEmail: mocks.getPersonByVerifiedEmail,
  createPerson: mocks.createPerson,
  insertIdentity: mocks.insertIdentity,
  listIdentitiesForUser: mocks.listIdentitiesForUser,
  listWalletPubkeysForUser: mocks.listWalletPubkeysForUser,
  setVerifiedPrimaryEmail: mocks.setVerifiedPrimaryEmail,
  touchIdentityLogin: mocks.touchIdentityLogin,
}));
vi.mock("../../db/queries.js", async (orig) => ({
  ...(await orig<typeof import("../../db/queries.js")>()),
  listTurnkeyResourcesForUserForApp: mocks.listTurnkeyResourcesForUserForApp,
  insertTurnkeyResource: mocks.insertTurnkeyResource,
}));
vi.mock("../../auth/sessionToken.js", async (orig) => ({
  ...(await orig<typeof import("../../auth/sessionToken.js")>()),
  mintSessionForUser: mocks.mintSessionForUser,
  resolveSessionToken: async () => null,
}));

import { createIdTokenSigner, jwksDocument, verifyIdToken } from "../../auth/idToken.js";
import { registerSessionAuth } from "../../plugins/sessionAuth.js";
import { registerAuthOAuthRoutes, registerJwksRoute } from "../authOAuth.js";

const ISSUER = "https://hub.test";
const signer = createIdTokenSigner({ issuer: ISSUER, privateJwkJson: undefined, allowEphemeral: true });

async function buildServer(clientIds = "client-1") {
  const app = Fastify();
  app.decorate("config", { TURNKEY_ORGANIZATION_ID: ROOT_ORG, SESSION_ENFORCED_ROUTES: "", GOOGLE_OAUTH_CLIENT_IDS: clientIds, NODE_ENV: "test" } as never);
  app.decorate("idTokenSigner", signer);
  app.addHook("onRequest", async (request) => {
    (request as any).app = { appId: "app", apiKeyId: "key", apiKeyPrefix: "p" };
  });
  await app.register(sensible);
  await app.register(registerSessionAuth);
  await app.register(registerAuthOAuthRoutes, { prefix: "/v1" });
  await app.register(registerJwksRoute);
  await app.ready();
  return app;
}

const body = (overrides: Record<string, unknown> = {}) => ({ provider: "google", oidcToken: "header.payload.signature", publicKey: SESSION_KEY, ...overrides });

const existingResource = { id: "res-1", app_id: "app", user_id: "user-1", organization_id: SUB_ORG, turnkey_root_user_id: "root-1", wallet_id: "wallet-1", default_address: "tb1p-old", default_public_key_hex: WALLET_KEY, auth_method: "oauth", key_verified_at: "2026-01-01", created_at: "2026-01-01" };
const existingPerson = { id: "user-1", external_user_id: "usr_existing", primary_email: "jonah@arch.network", email_verified_at: "2026-01-01", recovery_email: null, created_at: "2026-01-01" };

describe("POST /v1/auth/oauth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyOidcToken.mockResolvedValue(claims());
    mocks.recordOidcTokenUse.mockResolvedValue({ replayed: false });
    mocks.getIdentity.mockResolvedValue(null);
    mocks.getPersonByVerifiedEmail.mockResolvedValue(null);
    mocks.listTurnkeyResourcesForUserForApp.mockResolvedValue([]);
    mocks.listIdentitiesForUser.mockResolvedValue([]);
  });

  it("signs up: creates the person, the OAuth sub-org and both identities, then opens the session", async () => {
    mocks.getPerson.mockResolvedValue({ id: "user-new", external_user_id: "usr_new", primary_email: "jonah@arch.network", email_verified_at: "2026-01-01" });
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body(), headers: { "x-network": "testnet" } });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.created).toBe(true);
    expect(json.externalUserId).toBe("usr_new");
    expect(json.organizationId).toBe(SUB_ORG);
    expect(json.defaultPublicKeyHex).toBe(WALLET_KEY);
    expect(json.sessionToken).toBe("whs_v1_test");

    const create = mocks.turnkey.createSubOrganizationWithOAuthWallet.mock.calls[0]![0];
    expect(create.provider).toEqual({ providerName: "google", oidcToken: "header.payload.signature" });
    expect(create.wallet.addressFormat).toBe("ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR");
    expect(mocks.insertTurnkeyResource.mock.calls[0]![1]).toMatchObject({ authMethod: "oauth", keyVerified: true, organizationId: SUB_ORG });
    const kinds = mocks.insertIdentity.mock.calls.map((c) => (c[1] as any).kind).sort();
    expect(kinds).toEqual(["email", "google"]);
    expect(mocks.turnkey.oauthLogin).toHaveBeenCalledWith(expect.objectContaining({ organizationId: SUB_ORG, publicKey: SESSION_KEY, expirationSeconds: "3600" }));

    const payload = verifyIdToken(json.idToken, jwksDocument(signer), ISSUER);
    expect(payload).toMatchObject({ sub: "usr_new", email: "jonah@arch.network", email_verified: true, wallets: [WALLET_KEY], amr: ["google"] });
    await app.close();
  });

  it("signs in an identity the Hub knows without creating anything", async () => {
    mocks.getIdentity.mockResolvedValue({ id: "ident-1", user_id: "user-1", kind: "google", subject: "goog-sub-1" });
    mocks.getPerson.mockResolvedValue(existingPerson);
    mocks.listTurnkeyResourcesForUserForApp.mockResolvedValue([existingResource]);
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toBe(false);
    expect(res.json().externalUserId).toBe("usr_existing");
    expect(mocks.turnkey.createSubOrganizationWithOAuthWallet).not.toHaveBeenCalled();
    expect(mocks.createPerson).not.toHaveBeenCalled();
    expect(mocks.touchIdentityLogin).toHaveBeenCalled();
    expect(mocks.turnkey.oauthLogin).toHaveBeenCalledWith(expect.objectContaining({ organizationId: SUB_ORG, publicKey: SESSION_KEY }));
    await app.close();
  });

  it("answers 409 identity_exists when the verified email already belongs to another person who holds a wallet", async () => {
    mocks.getPersonByVerifiedEmail.mockResolvedValue(existingPerson);
    mocks.listTurnkeyResourcesForUserForApp.mockResolvedValue([{ ...existingResource, auth_method: "email" }]);
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("identity_exists");
    expect(res.json().emailMasked).toMatch(/^j\*+@arch\.network$/);
    expect(mocks.turnkey.createSubOrganizationWithOAuthWallet).not.toHaveBeenCalled();
    expect(mocks.turnkey.oauthLogin).not.toHaveBeenCalled();
    await app.close();
  });

  it("rolls the sign-up back with 409 identity_raced when a racing sign-up took the provider identity first, auditing the orphaned sub-org", async () => {
    mocks.insertIdentity.mockResolvedValueOnce(null);
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("identity_raced");
    expect(mocks.turnkey.oauthLogin).not.toHaveBeenCalled();
    expect(mocks.mintSessionForUser).not.toHaveBeenCalled();
    const orphaned = mocks.auditEvent.mock.calls.map((c) => c[0] as any).find((e) => e.outcome === "failed" && e.eventType === "turnkey.wallet.create");
    expect(orphaned?.payloadJson).toMatchObject({ error: "identity_raced", subOrganizationId: SUB_ORG });
    await app.close();
  });

  it("adopts a verified-email person with no wallet and no provider identity: the residue of an unfinished sign-up", async () => {
    mocks.getPersonByVerifiedEmail.mockResolvedValue(existingPerson);
    mocks.listTurnkeyResourcesForUserForApp.mockResolvedValue([]);
    mocks.listIdentitiesForUser.mockResolvedValue([{ kind: "email" }] as never);
    mocks.getPerson.mockResolvedValue(existingPerson);
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: true, externalUserId: "usr_existing" });
    expect(mocks.createPerson).not.toHaveBeenCalled();
    expect(mocks.insertTurnkeyResource.mock.calls[0]![1]).toMatchObject({ userId: "user-1", authMethod: "oauth" });
    expect(mocks.turnkey.createSubOrganizationWithOAuthWallet.mock.calls[0]![0]).toMatchObject({ subOrganizationName: expect.stringContaining("usr_existing") });
    await app.close();
  });

  it("writes no person when Turnkey will not create the sub-org, so the next attempt is a clean sign-up", async () => {
    mocks.turnkey.createSubOrganizationWithOAuthWallet.mockRejectedValueOnce(new Error("ACTIVITY_STATUS_FAILED"));
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(res.statusCode).toBe(502);
    expect(mocks.createPerson).not.toHaveBeenCalled();
    expect(mocks.insertIdentity).not.toHaveBeenCalled();
    expect(mocks.turnkey.oauthLogin).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not treat an UNverified email as a collision", async () => {
    mocks.verifyOidcToken.mockResolvedValue(claims({ emailVerified: false }));
    mocks.getPersonByVerifiedEmail.mockResolvedValue(existingPerson);
    mocks.getPerson.mockResolvedValue({ id: "user-new", external_user_id: "usr_new", primary_email: "jonah@arch.network", email_verified_at: null });
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(res.statusCode).toBe(200);
    expect(mocks.getPersonByVerifiedEmail).not.toHaveBeenCalled();
    expect(res.json().emailVerified).toBe(false);
    await app.close();
  });

  it("refuses a replayed token and a token the verifier rejects", async () => {
    const app = await buildServer();
    mocks.recordOidcTokenUse.mockResolvedValue({ replayed: true });
    const replay = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(replay.statusCode).toBe(401);
    expect(mocks.turnkey.oauthLogin).not.toHaveBeenCalled();

    mocks.recordOidcTokenUse.mockResolvedValue({ replayed: false });
    const { OidcError } = await vi.importActual<typeof import("../../auth/oidc.js")>("../../auth/oidc.js");
    mocks.verifyOidcToken.mockRejectedValue(new OidcError("bad_nonce", "nope"));
    const bad = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().message).toMatch(/bad_nonce/);
    expect(mocks.recordOidcTokenUse).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("refuses a malformed session key and an unconfigured provider", async () => {
    const app = await buildServer();
    const bad = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body({ publicKey: "04" + "ab".repeat(32) }) });
    expect(bad.statusCode).toBe(400);
    await app.close();
    const off = await buildServer("");
    const res = await off.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(res.statusCode).toBe(503);
    await off.close();
  });

  it("answers 502 and audits when Turnkey will not open the session", async () => {
    mocks.getIdentity.mockResolvedValue({ id: "ident-1", user_id: "user-1", kind: "google", subject: "goog-sub-1" });
    mocks.getPerson.mockResolvedValue(existingPerson);
    mocks.listTurnkeyResourcesForUserForApp.mockResolvedValue([existingResource]);
    mocks.turnkey.oauthLogin.mockRejectedValueOnce(new Error("ACTIVITY_STATUS_FAILED"));
    const app = await buildServer();
    const res = await app.inject({ method: "POST", url: "/v1/auth/oauth", payload: body() });
    expect(res.statusCode).toBe(502);
    expect(mocks.mintSessionForUser).not.toHaveBeenCalled();
    expect(mocks.auditEvent.mock.calls.some((c) => (c[0] as any).eventType === "auth.oauth.login" && (c[0] as any).outcome === "failed")).toBe(true);
    await app.close();
  });
});

describe("JWKS", () => {
  it("serves the signer's public key at the root and under /v1", async () => {
    const app = await buildServer();
    for (const url of ["/.well-known/jwks.json", "/v1/auth/jwks"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.json().keys[0].kid).toBe(signer.kid);
      expect(res.json().keys[0].d).toBeUndefined();
    }
    await app.close();
  });
});
