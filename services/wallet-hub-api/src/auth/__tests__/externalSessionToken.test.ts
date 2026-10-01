import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import bs58 from "bs58";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Signer, Key, Address } from "@saturnbtcio/bip322-js";
import { verifyExternalChallengeSignature } from "../sessionToken.js";

/**
 * Real BIP-322 round-trip for the external-wallet session mint. We sign a
 * challenge message exactly the way a linked Xverse/UniSat wallet would
 * (bip322-js `Signer.sign`) and assert our `verifyExternalChallengeSignature`
 * wrapper (which the `/auth/session/external` route uses) accepts it and
 * rejects tampering. This is the same Verifier the wallet-linking flow uses,
 * so a wallet that can link can also mint a session.
 */

function doubleSha256(buf: Buffer): Buffer {
  return crypto.createHash("sha256").update(crypto.createHash("sha256").update(buf).digest()).digest();
}

/** Encode a 32-byte private key as a (mainnet, compressed) WIF. */
function privToWif(privHex: string): string {
  const payload = Buffer.concat([
    Buffer.from([0x80]),
    Buffer.from(privHex, "hex"),
    Buffer.from([0x01]),
  ]);
  const checksum = doubleSha256(payload).subarray(0, 4);
  return bs58.encode(Buffer.concat([payload, checksum]));
}

function makeTaprootKeypair(): { wif: string; address: string } {
  const priv = crypto.randomBytes(32);
  const privHex = priv.toString("hex");
  const compressed = secp256k1.getPublicKey(priv, true);
  const xOnly = Key.toXOnly(Buffer.from(compressed));
  const addrObj = Address.convertPubKeyIntoAddress(xOnly, "p2tr" as "p2tr") as Record<string, string>;
  return { wif: privToWif(privHex), address: addrObj.mainnet };
}

const MESSAGE = [
  "Wallet Hub session challenge",
  "App: 11111111-1111-1111-1111-111111111111",
  "User: install-abc",
  "Provider: xverse",
  "Nonce: deadbeef",
  "Expires: 2099-01-01T00:00:00.000Z",
].join("\n");

describe("verifyExternalChallengeSignature", () => {
  it("accepts a valid BIP-322 signature over the challenge message", () => {
    const { wif, address } = makeTaprootKeypair();
    const signature = Signer.sign(wif, address, MESSAGE) as string;
    expect(
      verifyExternalChallengeSignature({ address, message: MESSAGE, signature }),
    ).toBe(true);
  });

  it("rejects a signature over a tampered message", () => {
    const { wif, address } = makeTaprootKeypair();
    const signature = Signer.sign(wif, address, MESSAGE) as string;
    expect(
      verifyExternalChallengeSignature({
        address,
        message: MESSAGE + "\nNonce: tampered",
        signature,
      }),
    ).toBe(false);
  });

  it("rejects a signature checked against a different address", () => {
    const a = makeTaprootKeypair();
    const b = makeTaprootKeypair();
    const signature = Signer.sign(a.wif, a.address, MESSAGE) as string;
    expect(
      verifyExternalChallengeSignature({ address: b.address, message: MESSAGE, signature }),
    ).toBe(false);
  });

  it("returns false (not throws) on a garbage signature", () => {
    const { address } = makeTaprootKeypair();
    expect(
      verifyExternalChallengeSignature({
        address,
        message: MESSAGE,
        signature: "not-a-real-signature",
      }),
    ).toBe(false);
  });
});
