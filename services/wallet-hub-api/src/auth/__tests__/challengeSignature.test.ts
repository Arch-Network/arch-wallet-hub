import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, numberToBytesBE } from "@noble/curves/abstract/utils";
import { sha256 } from "@noble/hashes/sha256";
import { bip341TweakedOutputKeyHex } from "../../arch/address.js";
import { verifyChallengeSignature } from "../sessionToken.js";

/**
 * Turnkey-shaped round-trip for the Turnkey session mint.
 *
 * A P2TR Turnkey wallet account signs SIGN_RAW_PAYLOAD_V2 with the
 * BIP-341 *tweaked* output key -- that's what makes its signatures
 * valid taproot key-path spends, and it's the key
 * /signing-requests/:id/submit verifies against. The key we store on
 * `turnkey_resources.default_public_key_hex` is the untweaked internal
 * key. Verifying the challenge against only the internal key made
 * POST /auth/session return 401 InvalidSignature for every real
 * wallet, which blocked sends once session enforcement landed.
 */

function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(Buffer.from(tag, "utf8"));
  return sha256(Buffer.concat([tagHash, tagHash, Buffer.from(data)]));
}

/**
 * The private key a taproot signer uses for a BIP-86 key-path spend:
 * d' = (d_even + tagged_hash("TapTweak", P.x)) mod n, where d_even is
 * negated when P has an odd y so it commits to the x-only key.
 */
function bip86TweakedPrivateKey(priv: Uint8Array): Uint8Array {
  const n = secp256k1.CURVE.n;
  const d = BigInt(`0x${bytesToHex(priv)}`);
  const point = secp256k1.ProjectivePoint.BASE.multiply(d).toAffine();
  const dEven = point.y % 2n === 0n ? d : n - d;
  const internalX = numberToBytesBE(point.x, 32);
  const t = BigInt(`0x${bytesToHex(taggedHash("TapTweak", internalX))}`);
  return numberToBytesBE((dEven + t) % n, 32);
}

function makeAccount() {
  const priv = crypto.randomBytes(32);
  return {
    priv,
    tweakedPriv: bip86TweakedPrivateKey(priv),
    /** What Turnkey returns from walletAccounts and we persist. */
    compressedInternalHex: bytesToHex(secp256k1.getPublicKey(priv, true)),
  };
}

const payloadHex = crypto.randomBytes(32).toString("hex");

function sign(privateKey: Uint8Array): string {
  return bytesToHex(
    schnorr.sign(Uint8Array.from(Buffer.from(payloadHex, "hex")), privateKey),
  );
}

describe("verifyChallengeSignature (Turnkey taproot signer)", () => {
  it("accepts a signature made with the BIP-341 tweaked output key", () => {
    const account = makeAccount();
    expect(
      verifyChallengeSignature({
        payloadHex,
        signatureHex: sign(account.tweakedPriv),
        defaultPublicKeyHex: account.compressedInternalHex,
      }),
    ).toBe(true);
  });

  it("still accepts a signature made with the untweaked internal key", () => {
    const account = makeAccount();
    expect(
      verifyChallengeSignature({
        payloadHex,
        signatureHex: sign(account.priv),
        defaultPublicKeyHex: account.compressedInternalHex,
      }),
    ).toBe(true);
  });

  it("rejects a tweaked signature from a different account", () => {
    const account = makeAccount();
    const other = makeAccount();
    expect(
      verifyChallengeSignature({
        payloadHex,
        signatureHex: sign(other.tweakedPriv),
        defaultPublicKeyHex: account.compressedInternalHex,
      }),
    ).toBe(false);
  });

  it("derives the same output key the taproot address commits to", () => {
    // Guards the assumption above: the key that verifies the signature
    // is exactly the witness program of the account's p2tr address.
    const account = makeAccount();
    const internalXOnly = account.compressedInternalHex.slice(2);
    const outputKey = bytesToHex(schnorr.getPublicKey(account.tweakedPriv));
    expect(outputKey).toBe(bip341TweakedOutputKeyHex(internalXOnly));
  });
});
