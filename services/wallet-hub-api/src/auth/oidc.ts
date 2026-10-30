/**
 * OIDC id-token verification for social login.
 *
 * Turnkey verifies the same token again inside its enclave before it
 * registers a session key (OAUTH_LOGIN), so this check is not what keeps
 * the wallet safe. It is what lets the Hub trust `sub`, `email` and
 * `email_verified` for ITS OWN index -- the person record, the identity
 * row, the collision check -- before a single Turnkey activity is spent,
 * and what lets it refuse a token bound to a different session key with a
 * clean 401 instead of an opaque Turnkey failure.
 *
 * Verification is the standard OIDC recipe, done with node:crypto so no
 * JWT library joins the dependency set:
 *   - header `alg` must be RS256 (Google and Apple) or ES256; `kid` names a key in
 *     the issuer's JWKS, fetched from the issuer's own well-known document
 *     and cached for JWKS_TTL_MS (Google rotates about every six hours);
 *   - `iss` must be one the provider is known to use;
 *   - `aud` must be one of the app's registered client ids (a token minted
 *     for someone else's client is not ours);
 *   - `exp` / `iat` within skew;
 *   - `nonce` must equal sha256(sessionPublicKey) -- the exact rule Turnkey
 *     enforces (its worked example: hashing the lowercase compressed-key
 *     hex string as UTF-8 text yields the documented nonce), so a token
 *     that fails here would fail there too.
 *
 * A JWKS miss on an unknown `kid` refreshes the cache once: a key rotated
 * between fetches must not strand every login for the TTL.
 */

import crypto from "node:crypto";
import { sha256Hex } from "./sessionToken.js";

export type OidcProvider = "google" | "apple";

export type OidcClaims = {
  provider: OidcProvider;
  issuer: string;
  subject: string;
  audience: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /**
   * Apple only: the email is a Hide-My-Email relay (`@privaterelay.appleid.com`),
   * which forwards to the person only from senders Apple has been told about
   * (the app's registered email sources). Still unique and still verified.
   */
  privateRelay: boolean;
  expiresAt: Date;
  /** sha256 of the raw token: the replay key. */
  tokenHash: string;
};

export type OidcProviderConfig = {
  provider: OidcProvider;
  issuers: readonly string[];
  jwksUrl: string;
  /** Client ids this Hub accepts as `aud`. Empty means the provider is off. */
  clientIds: readonly string[];
};

export class OidcError extends Error {
  readonly code:
    | "malformed"
    | "unsupported_alg"
    | "unknown_key"
    | "bad_signature"
    | "bad_issuer"
    | "bad_audience"
    | "expired"
    | "not_yet_valid"
    | "bad_nonce"
    | "jwks_unavailable";
  constructor(code: OidcError["code"], message: string) {
    super(message);
    this.name = "OidcError";
    this.code = code;
  }
}

const JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const JWKS_TIMEOUT_MS = 5_000;

type Jwk = crypto.JsonWebKey & { kid?: string; alg?: string; use?: string };

type JwksCacheEntry = { keys: Jwk[]; fetchedAt: number };

const jwksCache = new Map<string, JwksCacheEntry>();

export const GOOGLE_PROVIDER: Omit<OidcProviderConfig, "clientIds"> = {
  provider: "google",
  // Google documents both spellings as valid issuer values.
  issuers: ["https://accounts.google.com", "accounts.google.com"],
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
};

/**
 * Sign in with Apple for the web. `aud` is the Services ID (the web
 * "client_id", e.g. network.arch.prime.web), not the App ID. Apple signs
 * with RS256 and rotates its JWKS; `email_verified` and `is_private_email`
 * arrive as strings in some tokens, booleans in others.
 */
export const APPLE_PROVIDER: Omit<OidcProviderConfig, "clientIds"> = {
  provider: "apple",
  issuers: ["https://appleid.apple.com"],
  jwksUrl: "https://appleid.apple.com/auth/keys",
};

export function oauthNonceFor(sessionPublicKeyHex: string): string {
  return sha256Hex(sessionPublicKeyHex.toLowerCase());
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

function parseJsonPart(part: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(part).toString("utf8"));
  } catch {
    throw new OidcError("malformed", `OIDC token ${what} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OidcError("malformed", `OIDC token ${what} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

async function fetchJwks(url: string, fetchImpl: typeof fetch): Promise<Jwk[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new OidcError("jwks_unavailable", `JWKS fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new OidcError("jwks_unavailable", "JWKS has no keys array");
    return body.keys as Jwk[];
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError("jwks_unavailable", `JWKS fetch failed: ${String((err as Error)?.message ?? err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function keyFor(
  jwksUrl: string,
  kid: string,
  fetchImpl: typeof fetch,
  now: number,
): Promise<Jwk> {
  const cached = jwksCache.get(jwksUrl);
  const fresh = cached && now - cached.fetchedAt < JWKS_TTL_MS;
  const hit = fresh ? cached.keys.find((k) => k.kid === kid) : undefined;
  if (hit) return hit;
  // Unknown kid or stale cache: one refresh, then give up.
  const keys = await fetchJwks(jwksUrl, fetchImpl);
  jwksCache.set(jwksUrl, { keys, fetchedAt: now });
  const found = keys.find((k) => k.kid === kid);
  if (!found) throw new OidcError("unknown_key", `No JWKS key with kid ${kid}`);
  return found;
}

/** Test seam: pre-seed or clear the JWKS cache. */
export function _setJwksCacheForTests(jwksUrl: string, keys: Jwk[] | null): void {
  if (keys === null) jwksCache.delete(jwksUrl);
  else jwksCache.set(jwksUrl, { keys, fetchedAt: Date.now() });
}

function verifySignature(alg: string, jwk: Jwk, signingInput: string, signature: Buffer): boolean {
  const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
  if (alg === "RS256") {
    return crypto.verify("sha256", Buffer.from(signingInput), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
  }
  if (alg === "ES256") {
    return crypto.verify("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" }, signature);
  }
  throw new OidcError("unsupported_alg", `Unsupported OIDC alg ${alg}`);
}

/**
 * Verify an id token and return the claims the Hub keys on. Throws
 * `OidcError`; the route maps codes to 401s with a stable `message`.
 */
export async function verifyOidcToken(params: {
  token: string;
  config: OidcProviderConfig;
  /** The compressed P-256 hex the client will present to OAUTH_LOGIN. */
  sessionPublicKeyHex: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<OidcClaims> {
  const { token, config } = params;
  const now = params.now ?? new Date();
  const fetchImpl = params.fetchImpl ?? fetch;

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new OidcError("malformed", "OIDC token is not a compact JWS");
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = parseJsonPart(headerPart, "header");
  const payload = parseJsonPart(payloadPart, "payload");

  const alg = typeof header.alg === "string" ? header.alg : "";
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (alg !== "RS256" && alg !== "ES256") throw new OidcError("unsupported_alg", `Unsupported OIDC alg ${alg || "(none)"}`);
  if (!kid) throw new OidcError("malformed", "OIDC token header has no kid");

  const jwk = await keyFor(config.jwksUrl, kid, fetchImpl, now.getTime());
  let valid = false;
  try {
    valid = verifySignature(alg, jwk, `${headerPart}.${payloadPart}`, base64UrlDecode(signaturePart));
  } catch (err) {
    if (err instanceof OidcError) throw err;
    throw new OidcError("bad_signature", "OIDC token signature could not be verified");
  }
  if (!valid) throw new OidcError("bad_signature", "OIDC token signature is invalid");

  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (!config.issuers.includes(iss)) throw new OidcError("bad_issuer", `OIDC issuer ${iss || "(none)"} is not ${config.provider}`);

  const audRaw = payload.aud;
  const audiences = Array.isArray(audRaw) ? audRaw.filter((a): a is string => typeof a === "string") : typeof audRaw === "string" ? [audRaw] : [];
  const audience = audiences.find((a) => config.clientIds.includes(a));
  if (!audience) throw new OidcError("bad_audience", "OIDC token audience is not one of this app's client ids");

  const exp = typeof payload.exp === "number" ? payload.exp * 1000 : NaN;
  if (!Number.isFinite(exp) || exp + CLOCK_SKEW_MS < now.getTime()) throw new OidcError("expired", "OIDC token has expired");
  const iat = typeof payload.iat === "number" ? payload.iat * 1000 : NaN;
  if (Number.isFinite(iat) && iat - CLOCK_SKEW_MS > now.getTime()) throw new OidcError("not_yet_valid", "OIDC token is not yet valid");

  const expectedNonce = oauthNonceFor(params.sessionPublicKeyHex);
  const nonce = typeof payload.nonce === "string" ? payload.nonce : typeof payload.tknonce === "string" ? payload.tknonce : "";
  if (nonce.toLowerCase() !== expectedNonce) throw new OidcError("bad_nonce", "OIDC token nonce is not bound to this session key");

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new OidcError("malformed", "OIDC token has no sub");

  const email = typeof payload.email === "string" && payload.email.includes("@") ? payload.email.trim() : null;
  // Google sends a boolean; Apple sends the string "true" in some tokens.
  const emailVerifiedRaw = payload.email_verified;
  const emailVerified = emailVerifiedRaw === true || emailVerifiedRaw === "true";
  const privateRelayRaw = payload.is_private_email;
  const privateRelay = privateRelayRaw === true || privateRelayRaw === "true";

  return {
    provider: config.provider,
    issuer: iss,
    subject: sub,
    audience,
    email,
    emailVerified: email !== null && emailVerified,
    name: typeof payload.name === "string" && payload.name.trim().length > 0 ? payload.name.trim() : null,
    privateRelay,
    expiresAt: new Date(exp),
    tokenHash: sha256Hex(token),
  };
}
