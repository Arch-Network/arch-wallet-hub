/**
 * Tests for the Wallet Hub API's `verifyChallengeSignature`.
 *
 * Imports the server file directly via a relative path so this
 * codifies the cross-package contract: any change to the server's
 * verification logic that breaks these tests is a wire-protocol
 * break the chrome-wallet needs to know about.
 */

import { describe, it, expect } from "vitest";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/curves/abstract/utils";
import { verifyChallengeSignature } from "../../../../../services/wallet-hub-api/src/auth/sessionToken";

function makeKeyPair() {
  const privateKey = schnorr.utils.randomPrivateKey();
  const publicKey = schnorr.getPublicKey(privateKey); // 32-byte xOnly
  return {
    privateKeyHex: bytesToHex(privateKey),
    publicKeyHex: bytesToHex(publicKey),
  };
}

function signPayload(payloadHex: string, privateKeyHex: string): string {
  const sig = schnorr.sign(
    Uint8Array.from(Buffer.from(payloadHex, "hex")),
    Uint8Array.from(Buffer.from(privateKeyHex, "hex")),
  );
  return bytesToHex(sig);
}

describe("verifyChallengeSignature", () => {
  it("accepts a valid schnorr signature over the canonical payload", () => {
    const { privateKeyHex, publicKeyHex } = makeKeyPair();
    const payloadHex = "a".repeat(64); // 32 bytes
    const signatureHex = signPayload(payloadHex, privateKeyHex);
    expect(
      verifyChallengeSignature({
        payloadHex,
        signatureHex,
        defaultPublicKeyHex: publicKeyHex,
      }),
    ).toBe(true);
  });

  it("rejects a signature from a different key", () => {
    const a = makeKeyPair();
    const b = makeKeyPair();
    const payloadHex = "b".repeat(64);
    const signatureHex = signPayload(payloadHex, a.privateKeyHex);
    expect(
      verifyChallengeSignature({
        payloadHex,
        signatureHex,
        defaultPublicKeyHex: b.publicKeyHex,
      }),
    ).toBe(false);
  });

  it("rejects a signature over a different payload", () => {
    const { privateKeyHex, publicKeyHex } = makeKeyPair();
    const signedPayload = "c".repeat(64);
    const targetPayload = "d".repeat(64);
    const signatureHex = signPayload(signedPayload, privateKeyHex);
    expect(
      verifyChallengeSignature({
        payloadHex: targetPayload,
        signatureHex,
        defaultPublicKeyHex: publicKeyHex,
      }),
    ).toBe(false);
  });

  it("rejects malformed inputs gracefully (no throw)", () => {
    // The verification path is reachable from a public API surface;
    // it MUST not throw on garbage. Earlier iterations called
    // schnorr.verify directly and would surface a 500 on bad
    // signatures; now those become a clean boolean false.
    expect(
      verifyChallengeSignature({
        payloadHex: "deadbeef", // 4 bytes, not 32
        signatureHex: "00".repeat(64),
        defaultPublicKeyHex: "11".repeat(32),
      }),
    ).toBe(false);
    expect(
      verifyChallengeSignature({
        payloadHex: "x".repeat(64), // non-hex chars
        signatureHex: "y".repeat(128),
        defaultPublicKeyHex: "z".repeat(64),
      }),
    ).toBe(false);
    expect(
      verifyChallengeSignature({
        payloadHex: "",
        signatureHex: "",
        defaultPublicKeyHex: "",
      }),
    ).toBe(false);
  });

  it("accepts inputs with 0x prefixes (interop tolerance)", () => {
    const { privateKeyHex, publicKeyHex } = makeKeyPair();
    const payloadHex = "e".repeat(64);
    const signatureHex = signPayload(payloadHex, privateKeyHex);
    expect(
      verifyChallengeSignature({
        payloadHex: `0x${payloadHex}`,
        signatureHex: `0x${signatureHex}`,
        defaultPublicKeyHex: `0x${publicKeyHex}`,
      }),
    ).toBe(true);
  });

  it("accepts Turnkey-style compressed (66-hex) default public keys", () => {
    // Production turnkey_resources.default_public_key_hex is the
    // compressed secp256k1 form Turnkey returns from walletAccounts.
    // Session mint used to reject these with length !== 64, which
    // made every real Turnkey user hit InvalidSignature on
    // POST /auth/session.
    const { privateKeyHex, publicKeyHex } = makeKeyPair();
    const payloadHex = "f".repeat(64);
    const signatureHex = signPayload(payloadHex, privateKeyHex);
    for (const prefix of ["02", "03"] as const) {
      expect(
        verifyChallengeSignature({
          payloadHex,
          signatureHex,
          defaultPublicKeyHex: `${prefix}${publicKeyHex}`,
        }),
      ).toBe(true);
    }
  });

  it("accepts uncompressed (130-hex) default public keys", () => {
    const privateKey = schnorr.utils.randomPrivateKey();
    const uncompressed = bytesToHex(secp256k1.getPublicKey(privateKey, false));
    const xOnly = uncompressed.slice(2, 66);
    const payloadHex = "a1".repeat(32);
    const signatureHex = bytesToHex(
      schnorr.sign(Uint8Array.from(Buffer.from(payloadHex, "hex")), privateKey),
    );
    expect(xOnly).toHaveLength(64);
    expect(
      verifyChallengeSignature({
        payloadHex,
        signatureHex,
        defaultPublicKeyHex: uncompressed,
      }),
    ).toBe(true);
  });
});
