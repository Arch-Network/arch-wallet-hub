/**
 * The Arch ID token: how identity leaves the Hub.
 *
 * Other services (arch-prime-rewards' profile, a notifier) must be able to
 * answer "which person is this wallet?" without a call back to the Hub and
 * without a shared secret. So the Hub signs a short-lived ES256 JWT that
 * names the person (`sub` = external_user_id), their verified email, and
 * every wallet pubkey it holds for them, and publishes the public keys at
 * `/.well-known/jwks.json`. A verifier caches the JWKS and checks the
 * signature offline, exactly as a Privy or Auth0 access token is checked.
 *
 * Fifteen minutes: enough for one rewards write, short enough that a leaked
 * token is not a standing credential. A token alone READS nothing here or
 * elsewhere -- rewards still demands the wallet's own BIP-322 signature on
 * every write; the ID token only says whose wallet it is.
 *
 * Keys: `ID_TOKEN_PRIVATE_JWK` (a P-256 private JWK, JSON) in production.
 * In dev/test an ephemeral key is generated at boot so a fresh checkout
 * works; tokens then die with the process, which is fine locally. Rotation
 * is "add a key, wait one TTL, retire the old one": `ID_TOKEN_PREVIOUS_JWKS`
 * may list retired public keys that still appear in the JWKS.
 */

import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { listWalletPubkeysForUser } from "../db/identities.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Created once in server.ts; every route that mints or publishes ID tokens reads it here. */
    idTokenSigner: IdTokenSigner;
  }
}

export const ID_TOKEN_TTL_SECONDS = 15 * 60;
export const ID_TOKEN_AUDIENCE = "arch";

export type IdTokenClaims = {
  sub: string;
  app: string;
  email: string | null;
  email_verified: boolean;
  wallets: string[];
  amr: string[];
};

export type IdTokenSigner = {
  issuer: string;
  kid: string;
  privateKey: crypto.KeyObject;
  publicJwk: crypto.JsonWebKey & { kid: string; alg: "ES256"; use: "sig" };
  previousPublicJwks: Array<crypto.JsonWebKey & { kid: string }>;
  /** True when the key was generated at boot rather than configured. */
  ephemeral: boolean;
};

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function kidOf(publicJwk: crypto.JsonWebKey): string {
  // RFC 7638 thumbprint over the required EC members, lexicographic.
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y });
  return crypto.createHash("sha256").update(canonical).digest("base64url").slice(0, 16);
}

export function createIdTokenSigner(params: {
  issuer: string;
  privateJwkJson: string | undefined;
  previousJwksJson?: string | undefined;
  allowEphemeral: boolean;
}): IdTokenSigner {
  let privateKey: crypto.KeyObject;
  let ephemeral = false;
  if (params.privateJwkJson && params.privateJwkJson.trim().length > 0) {
    let jwk: crypto.JsonWebKey;
    try {
      jwk = JSON.parse(params.privateJwkJson) as crypto.JsonWebKey;
    } catch {
      throw new Error("ID_TOKEN_PRIVATE_JWK is not valid JSON");
    }
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
      throw new Error("ID_TOKEN_PRIVATE_JWK must be a P-256 EC private key (kty EC, crv P-256, with d)");
    }
    privateKey = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  } else {
    if (!params.allowEphemeral) {
      throw new Error("ID_TOKEN_PRIVATE_JWK is required outside development/test");
    }
    privateKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    ephemeral = true;
  }
  const publicExport = crypto.createPublicKey(privateKey).export({ format: "jwk" }) as crypto.JsonWebKey;
  const kid = kidOf(publicExport);
  const publicJwk = { ...publicExport, kid, alg: "ES256" as const, use: "sig" as const };

  let previousPublicJwks: Array<crypto.JsonWebKey & { kid: string }> = [];
  if (params.previousJwksJson && params.previousJwksJson.trim().length > 0) {
    const parsed = JSON.parse(params.previousJwksJson) as unknown;
    const list = Array.isArray(parsed) ? parsed : [];
    previousPublicJwks = list
      .filter((k): k is crypto.JsonWebKey => typeof k === "object" && k !== null)
      .map((k) => ({ ...k, kid: typeof (k as { kid?: unknown }).kid === "string" ? (k as { kid: string }).kid : kidOf(k), alg: "ES256", use: "sig" }));
  }

  return { issuer: params.issuer, kid, privateKey, publicJwk, previousPublicJwks, ephemeral };
}

export function mintIdToken(signer: IdTokenSigner, claims: IdTokenClaims, now: Date = new Date()): { token: string; expiresAt: string } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + ID_TOKEN_TTL_SECONDS;
  const header = { alg: "ES256", typ: "JWT", kid: signer.kid };
  const payload = {
    iss: signer.issuer,
    sub: claims.sub,
    aud: ID_TOKEN_AUDIENCE,
    app: claims.app,
    email: claims.email,
    email_verified: claims.email_verified,
    wallets: claims.wallets,
    amr: claims.amr,
    iat,
    exp,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key: signer.privateKey, dsaEncoding: "ieee-p1363" });
  return { token: `${signingInput}.${base64Url(signature)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** An ID token for a Hub user: `wallets[]` is every pubkey the Hub holds for them, read on the caller's transaction. */
export async function mintIdentityToken(
  client: PoolClient,
  signer: IdTokenSigner,
  params: { appId: string; userId: string; externalUserId: string; email: string | null; emailVerified: boolean; amr: string[] },
): Promise<{ token: string; expiresAt: string }> {
  const wallets = await listWalletPubkeysForUser(client, { appId: params.appId, userId: params.userId });
  return mintIdToken(signer, {
    sub: params.externalUserId,
    app: params.appId,
    email: params.email,
    email_verified: params.emailVerified,
    wallets,
    amr: params.amr,
  });
}

export function jwksDocument(signer: IdTokenSigner): { keys: Array<crypto.JsonWebKey & { kid: string }> } {
  return { keys: [signer.publicJwk, ...signer.previousPublicJwks] };
}

/**
 * Verify a token this Hub minted. Used by the test suite and available to
 * any Node consumer that would rather import than reimplement.
 */
export function verifyIdToken(token: string, jwks: { keys: Array<crypto.JsonWebKey & { kid?: string }> }, issuer: string, now: Date = new Date()): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "ES256") return null;
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok) return null;
  if (payload.iss !== issuer || payload.aud !== ID_TOKEN_AUDIENCE) return null;
  if (typeof payload.exp !== "number" || payload.exp * 1000 < now.getTime()) return null;
  return payload;
}
