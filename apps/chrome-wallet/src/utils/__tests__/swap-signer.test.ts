/**
 * Regression test for the wallet ↔ swap-engine BIP-322 contract.
 *
 * The bug we're guarding against: `makeSwapSigner` used to double-encode
 * the challenge (hex of the UTF-8 bytes of an already-hex string) on its
 * way to the wallet. That used to round-trip cleanly because the wallet
 * called `hexToBytes(messageHashHex)` before BIP-322-hashing. Once the
 * wallet switched to the canonical "treat messageHashHex as a string and
 * UTF-8-encode it" convention (so dapp callers of `bip322-js.Signer.sign`
 * are byte-compatible), the double-encoded payload no longer matched what
 * the Arch validator BIP-322-verifies over, and every swap transaction
 * failed at submit with "BIP322 signature verification failed".
 *
 * This test pins both halves:
 *
 *   1. `makeSwapSigner` passes `challenge` through to the wallet
 *      unchanged. (Contract test, no crypto -- breaks if anyone re-adds
 *      the double-encode.)
 *
 *   2. The full loop (engine challenge → adapter → wallet BIP-322 sighash
 *      → schnorr sign → witness blob → off-the-shelf bip322-js Verifier)
 *      round-trips. This is the same end-to-end shape Arch performs.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { Buffer } from "buffer";
import { Verifier, Witness } from "@saturnbtcio/bip322-js";

import { makeSwapSigner } from "@arch/swap-engine";
import { computeBip322ToSignTaprootSighash, hexToBytes, bytesToHex } from "../bip322";

beforeAll(() => {
  bitcoin.initEccLib(ecc as any);
});

interface KeyPairLike {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  toWIF(): string;
}

function getEcpairFactory(): (ecc: unknown) => { makeRandom: (opts?: any) => KeyPairLike } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("ecpair");
  const factory = mod.ECPairFactory ?? mod.default;
  if (typeof factory !== "function") throw new Error("ecpair: ECPairFactory not found");
  return factory;
}

function deriveBip86Taproot(privateKey: Buffer, network: bitcoin.Network) {
  const compressedPub = ecc.pointFromScalar(privateKey, true);
  if (!compressedPub) throw new Error("Failed to derive public key");
  const internalXOnly = Buffer.from(compressedPub.slice(1, 33));
  const p2tr = bitcoin.payments.p2tr({ internalPubkey: internalXOnly, network });
  if (!p2tr.address) throw new Error("Failed to derive p2tr address");
  const tweak = (bitcoin.crypto as any).taggedHash("TapTweak", internalXOnly);
  const outputTweak = ecc.xOnlyPointAddTweak(internalXOnly, tweak);
  if (!outputTweak) throw new Error("xOnlyPointAddTweak failed");
  const outputXOnly = Buffer.from(outputTweak.xOnlyPubkey);
  let basePriv: Uint8Array = privateKey;
  if (compressedPub[0] === 0x03) {
    const neg = ecc.privateNegate(privateKey);
    if (!neg) throw new Error("privateNegate failed");
    basePriv = neg;
  }
  const tweakedPriv = ecc.privateAdd(basePriv, tweak);
  if (!tweakedPriv) throw new Error("privateAdd failed");
  return {
    address: p2tr.address,
    outputXOnly,
    tweakedPriv: Buffer.from(tweakedPriv),
  };
}

const signSchnorr = (ecc as any).signSchnorr as (
  h: Uint8Array,
  d: Uint8Array,
) => Uint8Array;

describe("makeSwapSigner", () => {
  it("forwards the challenge to the wallet verbatim (no double-hex)", async () => {
    const calls: Array<{ messageHashHex: string }> = [];
    const fakeWallet = {
      async signArchMessageHash(opts: { messageHashHex: string }) {
        calls.push(opts);
        return { signature64Hex: "ab".repeat(64) };
      },
    };

    const challenge =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const signer = makeSwapSigner(fakeWallet);
    await signer(challenge);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.messageHashHex).toBe(challenge);
  });

  it("end-to-end: signature it produces is accepted by a third-party BIP-322 Verifier", async () => {
    const ECPair = getEcpairFactory()(ecc);
    const network = bitcoin.networks.testnet;
    const kp = ECPair.makeRandom({ network });
    const { address, outputXOnly, tweakedPriv } = deriveBip86Taproot(
      Buffer.from(kp.privateKey),
      network,
    );

    // Engine's `getSigningChallenge` returns the UTF-8-decoded form of
    // `SanitizedMessageUtil.hash(message)`, which is the lowercase hex of
    // the final sha256. That's a 64-char hex string.
    const challenge =
      "deadbeefcafef00d1122334455667788aabbccddeeff00112233445566778899";

    const wallet = {
      async signArchMessageHash(opts: { messageHashHex: string }) {
        const sighash = computeBip322ToSignTaprootSighash({
          signerAddress: address,
          message: opts.messageHashHex,
        });
        const sig = signSchnorr(sighash, tweakedPriv);
        if (sig.length !== 64) throw new Error("expected 64-byte schnorr sig");
        // Sanity: sig verifies against the sighash + tweaked output key.
        const verifySchnorr = (ecc as any).verifySchnorr as (
          h: Uint8Array,
          Q: Uint8Array,
          s: Uint8Array,
        ) => boolean;
        expect(verifySchnorr(sighash, outputXOnly, sig)).toBe(true);
        return { signature64Hex: bytesToHex(sig) };
      },
    };

    const swapSigner = makeSwapSigner(wallet);
    const witnessBlob = await swapSigner(challenge);

    // The blob is what arch-swap returns from the signer callback. Arch's
    // validator (and bip322-js's stock Verifier) recover the schnorr sig
    // from the BIP-322 witness and verify it against the BIP-322 toSign
    // sighash for `(address, challenge)`. Verifier-side message argument
    // is the same challenge string the engine passed in -- and that's the
    // ONLY way this verifies, which is exactly what would have failed
    // when the adapter was double-encoding.
    expect(Verifier.verifySignature(address, challenge, witnessBlob)).toBe(true);

    // The witness blob is a base64-encoded simple witness with our 64-byte
    // schnorr sig as the only stack item. Make sure we didn't accidentally
    // append a sighash byte.
    const items = Witness.deserialize(witnessBlob);
    expect(items).toHaveLength(1);
    expect(items[0]!.length).toBe(64);
  });

  it("rejects malformed wallet responses instead of silently passing bad bytes", async () => {
    const wallet = {
      async signArchMessageHash() {
        return { signature64Hex: "ab".repeat(32) }; // 32 bytes, not 64
      },
    };
    const signer = makeSwapSigner(wallet);
    await expect(signer("dead".repeat(16))).rejects.toThrow(/expected 64 bytes/);
  });
});

// Silence unused-import warning for `hexToBytes` when the test file is
// imported through aliases that drop the dynamic require above.
void hexToBytes;
