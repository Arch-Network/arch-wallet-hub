import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { _setJwksCacheForTests, GOOGLE_PROVIDER, OidcError, oauthNonceFor, verifyOidcToken, type OidcProviderConfig } from "../oidc.js";

/**
 * A stand-in Google: an RSA key pair, a JWKS seeded into the verifier's
 * cache so no network is touched, and a helper that mints id tokens the
 * way Google does (RS256, `kid` in the header).
 */
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const SESSION_KEY = "0394e549c71fa99dd5cf752fba623090be314949b74e4cdf7ca72031dd638e281a";

const config: OidcProviderConfig = { ...GOOGLE_PROVIDER, clientIds: [CLIENT_ID] };

function b64u(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mint(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", typ: "JWT", kid: KID }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "1049",
    email: "jonah@arch.network",
    email_verified: true,
    iat: now - 10,
    exp: now + 3600,
    nonce: oauthNonceFor(SESSION_KEY),
    ...claims,
  };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  return `${signingInput}.${b64u(signature)}`;
}

_setJwksCacheForTests(GOOGLE_PROVIDER.jwksUrl, [{ ...(publicKey.export({ format: "jwk" }) as crypto.JsonWebKey), kid: KID, alg: "RS256", use: "sig" }]);

async function codeOf(token: string, sessionPublicKeyHex = SESSION_KEY): Promise<string> {
  try {
    await verifyOidcToken({ token, config, sessionPublicKeyHex });
    return "ok";
  } catch (err) {
    if (err instanceof OidcError) return err.code;
    throw err;
  }
}

describe("oauthNonceFor", () => {
  it("matches Turnkey's documented worked example (sha256 of the lowercase compressed-key hex as text)", () => {
    expect(oauthNonceFor(SESSION_KEY)).toBe("1663bba492a323085b13895634a3618792c4ec6896f3c34ef3c26396df22ef82");
    expect(oauthNonceFor(SESSION_KEY.toUpperCase())).toBe(oauthNonceFor(SESSION_KEY));
  });
});

describe("verifyOidcToken", () => {
  it("accepts a well-formed Google token bound to the session key", async () => {
    const claims = await verifyOidcToken({ token: mint({}), config, sessionPublicKeyHex: SESSION_KEY });
    expect(claims.provider).toBe("google");
    expect(claims.subject).toBe("1049");
    expect(claims.email).toBe("jonah@arch.network");
    expect(claims.emailVerified).toBe(true);
    expect(claims.audience).toBe(CLIENT_ID);
    expect(claims.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the bare issuer spelling Google also uses", async () => {
    expect(await codeOf(mint({ iss: "accounts.google.com" }))).toBe("ok");
  });

  it("refuses a token bound to a different session key", async () => {
    expect(await codeOf(mint({}), "02" + "ab".repeat(32))).toBe("bad_nonce");
    expect(await codeOf(mint({ nonce: "deadbeef" }))).toBe("bad_nonce");
  });

  it("accepts tknonce in place of nonce", async () => {
    expect(await codeOf(mint({ nonce: undefined, tknonce: oauthNonceFor(SESSION_KEY) }))).toBe("ok");
  });

  it("refuses the wrong audience, issuer, and an expired token", async () => {
    expect(await codeOf(mint({ aud: "someone-else" }))).toBe("bad_audience");
    expect(await codeOf(mint({ iss: "https://evil.example" }))).toBe("bad_issuer");
    expect(await codeOf(mint({ exp: Math.floor(Date.now() / 1000) - 600 }))).toBe("expired");
  });

  it("accepts an audience list when one entry is ours", async () => {
    expect(await codeOf(mint({ aud: ["other", CLIENT_ID] }))).toBe("ok");
  });

  it("refuses a forged signature and an unknown key", async () => {
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const token = mint({});
    const [h, p] = token.split(".") as [string, string, string];
    const forged = crypto.sign("sha256", Buffer.from(`${h}.${p}`), { key: other, padding: crypto.constants.RSA_PKCS1_PADDING });
    expect(await codeOf(`${h}.${p}.${b64u(forged)}`)).toBe("bad_signature");
    // Unknown kid triggers one JWKS refresh; the fetch here fails fast.
    const unknown = mint({}, { alg: "RS256", typ: "JWT", kid: "nope" });
    const code = await (async () => {
      try {
        await verifyOidcToken({ token: unknown, config, sessionPublicKeyHex: SESSION_KEY, fetchImpl: (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch });
        return "ok";
      } catch (err) {
        return err instanceof OidcError ? err.code : "other";
      }
    })();
    expect(code).toBe("jwks_unavailable");
  });

  it("refuses algorithms other than RS256 / ES256 and malformed tokens", async () => {
    expect(await codeOf(mint({}, { alg: "none", kid: KID }))).toBe("unsupported_alg");
    expect(await codeOf(mint({}, { alg: "HS256", kid: KID }))).toBe("unsupported_alg");
    expect(await codeOf("not.a.jwt.at.all")).toBe("malformed");
    expect(await codeOf("")).toBe("malformed");
  });

  it("treats a string email_verified as Apple sends it, and an unverified email as unverified", async () => {
    const asString = await verifyOidcToken({ token: mint({ email_verified: "true" }), config, sessionPublicKeyHex: SESSION_KEY });
    expect(asString.emailVerified).toBe(true);
    const unverified = await verifyOidcToken({ token: mint({ email_verified: false }), config, sessionPublicKeyHex: SESSION_KEY });
    expect(unverified.emailVerified).toBe(false);
    expect(unverified.email).toBe("jonah@arch.network");
  });
});
