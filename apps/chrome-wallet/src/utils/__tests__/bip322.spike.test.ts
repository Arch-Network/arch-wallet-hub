/**
 * Spike test: prove that the BIP-322 sighash computed by our wallet helper
 * is the exact digest a real BIP-322 verifier expects, for the path Turnkey
 * uses in production (SIGHASH_DEFAULT, 64-byte Schnorr).
 *
 * Strategy
 * --------
 *   1. Generate a Taproot keypair, derive its BIP-86 address.
 *   2. Sign the message TWICE:
 *        - canonically via bip322-js's `Signer.sign` (which happens to use
 *          SIGHASH_ALL and emits a 65-byte sig, like some legacy paths).
 *        - via a Turnkey-shaped path: compute our helper's SIGHASH_DEFAULT
 *          sighash and sign it directly with `ecc.signSchnorr` (a 64-byte sig).
 *   3. For (a), verify our helper produces a matching sighash *when given the
 *      same SIGHASH byte the wallet used*.
 *   4. For (b), build a real BIP-322 simple witness blob from the 64-byte
 *      sig and confirm `Verifier.verifySignature` accepts it. THIS is the
 *      proof that our production path works: the same code path Turnkey
 *      runs, validated by an off-the-shelf BIP-322 verifier.
 */

import { describe, expect, it, beforeAll } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { Buffer } from "buffer";
import { Address, BIP322, Signer, Verifier, Witness } from "@saturnbtcio/bip322-js";

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

  // Compute the BIP-86 output xOnly + tweaked private key the same way
  // Xverse/UniSat etc. do, so we can produce a SIGHASH_DEFAULT signature
  // (the kind Turnkey returns in production).
  const tweak = (bitcoin.crypto as any).taggedHash("TapTweak", internalXOnly);
  const outputTweak = ecc.xOnlyPointAddTweak(internalXOnly, tweak);
  if (!outputTweak) throw new Error("xOnlyPointAddTweak failed");
  const outputXOnly = Buffer.from(outputTweak.xOnlyPubkey);

  // BIP-86 private-key tweak: if the *internal* pubkey has odd Y, negate
  // the priv before adding the tweak.
  const internalCompressed = ecc.pointFromScalar(privateKey, true);
  if (!internalCompressed) throw new Error("internal pointFromScalar failed");
  let basePriv: Uint8Array = privateKey;
  if (internalCompressed[0] === 0x03) {
    const neg = ecc.privateNegate(privateKey);
    if (!neg) throw new Error("privateNegate failed");
    basePriv = neg;
  }
  const tweakedPriv = ecc.privateAdd(basePriv, tweak);
  if (!tweakedPriv) throw new Error("privateAdd failed");

  return {
    internalXOnly,
    outputXOnly,
    address: p2tr.address,
    tweakedPriv: Buffer.from(tweakedPriv),
  };
}

const verifySchnorr = (ecc as any).verifySchnorr as (
  h: Uint8Array,
  Q: Uint8Array,
  sig: Uint8Array,
) => boolean;
const signSchnorr = (ecc as any).signSchnorr as (
  h: Uint8Array,
  d: Uint8Array,
) => Uint8Array;

describe("computeBip322ToSignTaprootSighash", () => {
  it("produces a Uint8Array with exactly 32 bytes for a valid Taproot address", () => {
    const ECPair = getEcpairFactory()(ecc);
    const kp = ECPair.makeRandom({ network: bitcoin.networks.testnet });
    const { address } = deriveBip86Taproot(Buffer.from(kp.privateKey), bitcoin.networks.testnet);
    const sighash = computeBip322ToSignTaprootSighash({ signerAddress: address, message: "hello arch" });
    expect(sighash).toBeInstanceOf(Uint8Array);
    expect(sighash.length).toBe(32);
    expect(bytesToHex(sighash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the bip322-js Signer.sign sighash when given the wallet's SIGHASH type", () => {
    const ECPair = getEcpairFactory()(ecc);
    const network = bitcoin.networks.testnet;
    const kp = ECPair.makeRandom({ network });
    const { address } = deriveBip86Taproot(Buffer.from(kp.privateKey), network);
    const message = "spike: arch swap signing path";

    const sigBlob = Signer.sign(kp.toWIF(), address, message);
    expect(Verifier.verifySignature(address, message, sigBlob)).toBe(true);

    const witnessItems = Witness.deserialize(sigBlob);
    const rawSig = witnessItems[0];
    expect([64, 65]).toContain(rawSig.length);

    // bip322-js's default Signer.sign emits SIGHASH_ALL (0x01) → 65 bytes.
    // The actual schnorr signature is bytes [0:64], the SIGHASH byte is [64].
    const sighashType = rawSig.length === 65 ? rawSig[64] : 0x00;
    const schnorrSig = Buffer.from(rawSig.subarray(0, 64));

    const scriptPubKey = Buffer.from(bitcoin.address.toOutputScript(address, network));
    const outputXOnly = scriptPubKey.subarray(2);

    const ourSighash = computeBip322ToSignTaprootSighash({
      signerAddress: address,
      message,
      sighashType,
    });

    expect(verifySchnorr(ourSighash, outputXOnly, schnorrSig)).toBe(true);
  });

  it("PRODUCTION PATH: SIGHASH_DEFAULT 64-byte sig (Turnkey-shaped) verifies via real bip322 Verifier", () => {
    // This is the test that matters. It exactly mirrors what
    // `PasskeyTurnkeySigner.signArchMessageHash` does in the wallet, end-to-end:
    //   1. Compute the BIP-322 SIGHASH_DEFAULT sighash for (address, message).
    //   2. Sign that 32-byte sighash with raw schnorr (what Turnkey does over
    //      the tweaked output key behind the scenes).
    //   3. Wrap the resulting 64-byte sig as a single-item BIP-322 simple
    //      witness blob.
    //   4. Verify the blob with an off-the-shelf bip322 Verifier.
    //
    // If this passes, the wallet's swap signing path produces signatures
    // Arch (and any standard BIP-322 verifier) will accept.

    const ECPair = getEcpairFactory()(ecc);
    const network = bitcoin.networks.testnet;
    const kp = ECPair.makeRandom({ network });
    const { address, outputXOnly, tweakedPriv } = deriveBip86Taproot(
      Buffer.from(kp.privateKey),
      network,
    );
    const message = "spike: arch swap (turnkey path)";

    const ourSighash = computeBip322ToSignTaprootSighash({ signerAddress: address, message });
    expect(ourSighash.length).toBe(32);

    // Sign the 32-byte sighash with raw schnorr using the BIP-86-tweaked
    // private key. This is the digest-signing primitive Turnkey exposes via
    // SIGN_RAW_PAYLOAD + HASH_FUNCTION_NO_OP for Taproot keys.
    const schnorrSig = signSchnorr(ourSighash, tweakedPriv);
    expect(schnorrSig.length).toBe(64);

    // Sanity: the sig verifies against our sighash + the tweaked output key.
    expect(verifySchnorr(ourSighash, outputXOnly, schnorrSig)).toBe(true);

    // Wrap the 64-byte sig into a BIP-322 simple witness blob and verify it
    // through bip322-js's Verifier exactly as a third party would.
    const blob = Witness.serialize([schnorrSig]);
    expect(Verifier.verifySignature(address, message, blob)).toBe(true);
  });

  it("hexToBytes / bytesToHex round-trip", () => {
    const sample = new Uint8Array([0x00, 0x7f, 0xab, 0xcd, 0xff]);
    expect(hexToBytes(bytesToHex(sample))).toEqual(sample);
    expect(hexToBytes("0X" + bytesToHex(sample))).toEqual(sample);
  });
});
