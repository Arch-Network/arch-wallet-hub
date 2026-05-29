/**
 * Round-trip tests for the local-sighash + raw-payload signing
 * path used by SendRune to bypass Turnkey's PSBT validator.
 *
 * The cryptographic correctness check is: feed
 * `signPsbtViaRawSighash` a `sign32` callback that performs a real
 * BIP-340 Schnorr signature with the BIP-86-tweaked private key,
 * then finalize the PSBT and verify the resulting Transaction's
 * witness signature against the prevout x-only pubkey. If that
 * verifies, Turnkey's raw-payload result (which performs the same
 * Schnorr operation server-side over an unextractable key) will
 * also verify by construction.
 */
import { describe, it, expect } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import { Buffer } from "buffer";
import { psbtHasOpReturnOutput, signPsbtViaRawSighash } from "../psbt-raw-sign";

// Eager init: top-level `deriveBip86` calls inside `describe` blocks
// happen before vitest's `beforeAll`, so initializing inside one would
// fire too late.
bitcoin.initEccLib(ecc as any);

const signSchnorr = (ecc as any).signSchnorr as (
  msg: Uint8Array,
  priv: Uint8Array
) => Uint8Array;
const verifySchnorr = (ecc as any).verifySchnorr as (
  msg: Uint8Array,
  pub: Uint8Array,
  sig: Uint8Array
) => boolean;

function makePriv(seed: number): Buffer {
  // Deterministic 32-byte private key so tests are reproducible.
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(seed >>> 0, 28);
  buf[0] = 0x01;
  return buf;
}

interface TaprootKey {
  internalXOnly: Buffer;
  outputXOnly: Buffer;
  tweakedPriv: Buffer;
  address: string;
  scriptPubKey: Buffer;
}

function deriveBip86(privateKey: Buffer, network: bitcoin.Network): TaprootKey {
  const compressedPub = ecc.pointFromScalar(privateKey, true);
  if (!compressedPub) throw new Error("pointFromScalar failed");
  const internalXOnly = Buffer.from(compressedPub.slice(1, 33));
  const p2tr = bitcoin.payments.p2tr({ internalPubkey: internalXOnly, network });
  if (!p2tr.address || !p2tr.output) throw new Error("p2tr derive failed");

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
    internalXOnly,
    outputXOnly,
    tweakedPriv: Buffer.from(tweakedPriv),
    address: p2tr.address,
    scriptPubKey: Buffer.from(p2tr.output),
  };
}

function fullTxid(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

describe("psbtHasOpReturnOutput", () => {
  const network = bitcoin.networks.testnet;
  const key = deriveBip86(makePriv(1), network);

  function buildPsbt(addOpReturn: boolean) {
    const psbt = new bitcoin.Psbt({ network });
    psbt.addInput({
      hash: fullTxid(1),
      index: 0,
      witnessUtxo: { script: key.scriptPubKey, value: 10_000n },
    });
    if (addOpReturn) {
      psbt.addOutput({
        script: Buffer.from([0x6a, 0x02, 0x01, 0x02]),
        value: 0n,
      });
    }
    psbt.addOutput({ address: key.address, value: 5_000n });
    return psbt;
  }

  it("returns true when any output is OP_RETURN", () => {
    expect(psbtHasOpReturnOutput(buildPsbt(true))).toBe(true);
  });

  it("returns false when no output is OP_RETURN", () => {
    expect(psbtHasOpReturnOutput(buildPsbt(false))).toBe(false);
  });
});

describe("signPsbtViaRawSighash", () => {
  const network = bitcoin.networks.testnet;

  function buildRuneShapedPsbt(key: TaprootKey, inputCount: number) {
    const psbt = new bitcoin.Psbt({ network });
    for (let i = 0; i < inputCount; i++) {
      psbt.addInput({
        hash: fullTxid(i + 1),
        index: 0,
        witnessUtxo: { script: key.scriptPubKey, value: BigInt(10_000 + i) },
      });
    }
    // Output 0: OP_RETURN runestone-shaped (we don't need a real
    // runestone; signing only cares about the script *bytes*).
    psbt.addOutput({
      script: Buffer.from([0x6a, 0x5d, 0x04, 0x14, 0x01, 0x64, 0x01]),
      value: 0n,
    });
    psbt.addOutput({ address: key.address, value: 546n });
    psbt.addOutput({ address: key.address, value: 1_000n });
    return psbt;
  }

  function localSign32(tweakedPriv: Buffer) {
    return async (digestHex: string): Promise<string> => {
      const digest = Buffer.from(digestHex, "hex");
      const sig = signSchnorr(digest, tweakedPriv);
      return Buffer.from(sig).toString("hex");
    };
  }

  it("signs a single-input rune-shaped PSBT and the witness verifies", async () => {
    const key = deriveBip86(makePriv(2), network);
    const psbt = buildRuneShapedPsbt(key, 1);
    await signPsbtViaRawSighash(psbt, localSign32(key.tweakedPriv));

    // tapKeySig now populated -- finalize and pull the witness.
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    expect(tx.ins.length).toBe(1);
    expect(tx.ins[0]!.witness.length).toBe(1);
    expect(tx.ins[0]!.witness[0]!.length).toBe(64);

    // Recompute sighash the way Bitcoin Core / any verifier would
    // and verify the schnorr sig against the prevout x-only key.
    const digest = tx.hashForWitnessV1(0, [key.scriptPubKey], [10_000n], 0x00);
    const sig = tx.ins[0]!.witness[0]!;
    expect(verifySchnorr(digest, key.outputXOnly, sig)).toBe(true);
  });

  it("signs every input when the PSBT has multiple inputs", async () => {
    const key = deriveBip86(makePriv(3), network);
    const psbt = buildRuneShapedPsbt(key, 3);
    await signPsbtViaRawSighash(psbt, localSign32(key.tweakedPriv));
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    expect(tx.ins.length).toBe(3);

    const scripts = [key.scriptPubKey, key.scriptPubKey, key.scriptPubKey];
    const values = [10_000n, 10_001n, 10_002n];
    for (let i = 0; i < 3; i++) {
      const digest = tx.hashForWitnessV1(i, scripts, values, 0x00);
      const sig = tx.ins[i]!.witness[0]!;
      expect(verifySchnorr(digest, key.outputXOnly, sig)).toBe(true);
    }
  });

  it("rejects a PSBT with no inputs", async () => {
    const psbt = new bitcoin.Psbt({ network });
    await expect(
      signPsbtViaRawSighash(psbt, async () => "00".repeat(64))
    ).rejects.toThrow(/no inputs/);
  });

  it("rejects an input that isn't P2TR", async () => {
    const key = deriveBip86(makePriv(4), network);
    const psbt = new bitcoin.Psbt({ network });
    // P2WPKH script: OP_0 OP_PUSH20 <hash20> (22 bytes, not 34).
    const p2wpkhScript = Buffer.concat([
      Buffer.from([0x00, 0x14]),
      Buffer.alloc(20, 0xff),
    ]);
    psbt.addInput({
      hash: fullTxid(1),
      index: 0,
      witnessUtxo: { script: p2wpkhScript, value: 10_000n },
    });
    psbt.addOutput({ address: key.address, value: 5_000n });
    await expect(
      signPsbtViaRawSighash(psbt, async () => "00".repeat(64))
    ).rejects.toThrow(/not P2TR/);
  });

  it("rejects a sign32 callback returning the wrong number of bytes", async () => {
    const key = deriveBip86(makePriv(5), network);
    const psbt = buildRuneShapedPsbt(key, 1);
    await expect(
      signPsbtViaRawSighash(psbt, async () => "deadbeef")
    ).rejects.toThrow(/4 bytes for input 0 \(want 64\)/);
  });
});
