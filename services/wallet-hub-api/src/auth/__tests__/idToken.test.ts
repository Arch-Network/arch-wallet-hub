import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { ID_TOKEN_AUDIENCE, ID_TOKEN_TTL_SECONDS, createIdTokenSigner, jwksDocument, mintIdToken, verifyIdToken } from "../idToken.js";

const ISSUER = "https://hub.test";

describe("Arch ID token", () => {
  it("mints an ES256 token a JWKS consumer verifies offline", () => {
    const signer = createIdTokenSigner({ issuer: ISSUER, privateJwkJson: undefined, allowEphemeral: true });
    expect(signer.ephemeral).toBe(true);
    const { token, expiresAt } = mintIdToken(signer, {
      sub: "usr_abc",
      app: "app-1",
      email: "jonah@arch.network",
      email_verified: true,
      wallets: ["02" + "aa".repeat(32)],
      amr: ["google"],
    });
    const payload = verifyIdToken(token, jwksDocument(signer), ISSUER);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("usr_abc");
    expect(payload!.aud).toBe(ID_TOKEN_AUDIENCE);
    expect(payload!.email).toBe("jonah@arch.network");
    expect(payload!.wallets).toEqual(["02" + "aa".repeat(32)]);
    expect(payload!.amr).toEqual(["google"]);
    expect(typeof payload!.jti).toBe("string");
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(ID_TOKEN_TTL_SECONDS * 1000);
  });

  it("loads a configured P-256 private JWK and publishes a stable kid", () => {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = JSON.stringify(privateKey.export({ format: "jwk" }));
    const a = createIdTokenSigner({ issuer: ISSUER, privateJwkJson: jwk, allowEphemeral: false });
    const b = createIdTokenSigner({ issuer: ISSUER, privateJwkJson: jwk, allowEphemeral: false });
    expect(a.ephemeral).toBe(false);
    expect(a.kid).toBe(b.kid);
    expect(jwksDocument(a).keys[0]).toMatchObject({ kty: "EC", crv: "P-256", kid: a.kid, alg: "ES256", use: "sig" });
    expect((jwksDocument(a).keys[0] as { d?: string }).d).toBeUndefined();
  });

  it("refuses to boot without a key outside dev, and refuses a non-P-256 key", () => {
    expect(() => createIdTokenSigner({ issuer: ISSUER, privateJwkJson: undefined, allowEphemeral: false })).toThrow(/ID_TOKEN_PRIVATE_JWK/);
    const rsa = JSON.stringify(crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }));
    expect(() => createIdTokenSigner({ issuer: ISSUER, privateJwkJson: rsa, allowEphemeral: false })).toThrow(/P-256/);
  });

  it("rejects a token from another key, another issuer, or past its expiry", () => {
    const signer = createIdTokenSigner({ issuer: ISSUER, privateJwkJson: undefined, allowEphemeral: true });
    const other = createIdTokenSigner({ issuer: ISSUER, privateJwkJson: undefined, allowEphemeral: true });
    const claims = { sub: "usr_x", app: "app", email: null, email_verified: false, wallets: [], amr: ["session"] };
    const { token } = mintIdToken(signer, claims);
    expect(verifyIdToken(token, jwksDocument(other), ISSUER)).toBeNull();
    expect(verifyIdToken(token, jwksDocument(signer), "https://elsewhere")).toBeNull();
    const old = mintIdToken(signer, claims, new Date(Date.now() - 2 * ID_TOKEN_TTL_SECONDS * 1000)).token;
    expect(verifyIdToken(old, jwksDocument(signer), ISSUER)).toBeNull();
  });

  it("keeps retired public keys in the JWKS through a rotation", () => {
    const retired = createIdTokenSigner({ issuer: ISSUER, privateJwkJson: undefined, allowEphemeral: true });
    const { token } = mintIdToken(retired, { sub: "usr_r", app: "app", email: null, email_verified: false, wallets: [], amr: [] });
    const current = createIdTokenSigner({
      issuer: ISSUER,
      privateJwkJson: undefined,
      previousJwksJson: JSON.stringify([retired.publicJwk]),
      allowEphemeral: true,
    });
    expect(jwksDocument(current).keys.map((k) => k.kid)).toEqual([current.kid, retired.kid]);
    expect(verifyIdToken(token, jwksDocument(current), ISSUER)).not.toBeNull();
  });
});
