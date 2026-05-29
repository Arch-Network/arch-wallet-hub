/**
 * Sign a PSBT by computing each input's BIP-341 key-path sighash
 * locally and signing the 32-byte digest via an injected callback.
 *
 * Why this exists:
 *   Turnkey's `signTransaction` API for Bitcoin runs a server-side
 *   validator that tries to extract a payable address from every
 *   output in the PSBT. That works for ordinary sends, but it
 *   chokes on outputs whose script isn't an address -- in
 *   particular, the OP_RETURN runestone our rune-transfer PSBTs
 *   carry as output 0. The result is a hard signing failure:
 *
 *     Turnkey error 3: failed to extract bitcoin address from
 *     script with error: UnrecognizedScript (Details: [])
 *
 *   We can't change Turnkey's validator. We can avoid it by going
 *   one level lower: compute the BIP-341 sighash for each input
 *   ourselves (same primitive `bip322.ts` already uses for
 *   message-signing), hand each 32-byte digest to Turnkey's raw-
 *   payload signing API (which DOES NOT validate transaction
 *   shape), and stuff the resulting 64-byte Schnorr signature back
 *   into the PSBT as `tapKeySig`. The PSBT remains a standard
 *   PSBT that the wallet's normal finalize/broadcast path can
 *   consume; nothing downstream knows or cares.
 *
 * Scope:
 *   This module intentionally covers only the case the rune flow
 *   actually exercises today: taproot key-path spends from a
 *   single x-only key (the wallet's own taproot address) with
 *   SIGHASH_DEFAULT. Other paths (multisig, script-path,
 *   non-taproot inputs, mixed sighash types) will throw on
 *   detection rather than silently produce a bogus signature.
 *   When we add those flows we'll widen this -- explicit failure
 *   is the right default for crypto code.
 */
import * as bitcoin from "bitcoinjs-lib";

/**
 * Sign exactly one 32-byte digest with the user's Taproot key.
 *
 * Implementations MUST return a 64-byte (r||s) Schnorr signature
 * over the provided digest -- i.e. the output of
 * `BIP340.Schnorr.Sign(digest, taprootPrivKey)`. Turnkey's
 * `SIGN_RAW_PAYLOAD_V2` with `HASH_FUNCTION_NO_OP` +
 * `PAYLOAD_ENCODING_HEXADECIMAL` returns exactly this shape; see
 * `Signer.signArchPayload` for the wiring.
 */
export type Sign32ByteDigest = (digestHex: string) => Promise<string>;

/**
 * True if any output in `psbt` is an OP_RETURN data carrier. The
 * `Signer` uses this to decide between Turnkey's PSBT-signing API
 * (which works for plain sends but rejects unrecognized output
 * scripts) and the local-sighash path implemented below.
 *
 * We sniff the raw output script bytes -- OP_RETURN is opcode
 * `0x6a` and must be the first byte of the script. No need to
 * fully parse the script.
 */
export function psbtHasOpReturnOutput(psbt: bitcoin.Psbt): boolean {
  for (let i = 0; i < psbt.txOutputs.length; i++) {
    const script = psbt.txOutputs[i]?.script;
    if (script && script.length > 0 && script[0] === 0x6a) {
      return true;
    }
  }
  return false;
}

/**
 * Sign every input of `psbt` in place using `sign32` for each
 * input's BIP-341 key-path sighash. Returns the same PSBT (now
 * carrying `tapKeySig` on every input).
 *
 * Preconditions:
 *   - Every input has a `witnessUtxo` set (script + value).
 *   - Every input's prevout script is a 34-byte P2TR
 *     (`OP_1 OP_PUSH32 <x-only pubkey>`) controlled by the same
 *     key `sign32` will use to sign. We don't try to detect
 *     mixed-script inputs or remix sighash types -- callers
 *     building rune PSBTs control input selection and only feed
 *     in P2TR UTXOs belonging to the user's own taproot address.
 *
 * Postcondition:
 *   - Each input now has a `tapKeySig` field of length 64. The
 *     wallet's existing `finalizeSignedPsbt` pipeline will turn
 *     these into final witness data and emit a broadcastable tx.
 */
export async function signPsbtViaRawSighash(
  psbt: bitcoin.Psbt,
  sign32: Sign32ByteDigest
): Promise<bitcoin.Psbt> {
  const inputCount = psbt.inputCount;
  if (inputCount === 0) {
    throw new Error("signPsbtViaRawSighash: PSBT has no inputs");
  }

  // BIP-341 key-path sighash commits to ALL prevout scripts and
  // ALL prevout values, not just the input being signed. Walk
  // every input once up front so the per-input loop below stays
  // O(inputs).
  const prevoutScripts: Uint8Array[] = [];
  const prevoutValues: bigint[] = [];
  const dataInputs = (psbt as any).data?.inputs as Array<{
    witnessUtxo?: { script: Buffer; value: bigint };
  }>;
  if (!Array.isArray(dataInputs) || dataInputs.length !== inputCount) {
    throw new Error("signPsbtViaRawSighash: cannot read PSBT input map");
  }
  for (let i = 0; i < inputCount; i++) {
    const wu = dataInputs[i]?.witnessUtxo;
    if (!wu || !wu.script || typeof wu.value !== "bigint") {
      throw new Error(
        `signPsbtViaRawSighash: input ${i} missing witnessUtxo (script/value as BigInt)`
      );
    }
    // Be strict about script shape so we never accidentally sign a
    // non-P2TR input with the wrong sighash family. P2TR script is
    // OP_1 (0x51) + push 32 (0x20) + 32-byte x-only key = 34 bytes.
    if (wu.script.length !== 34 || wu.script[0] !== 0x51 || wu.script[1] !== 0x20) {
      throw new Error(
        `signPsbtViaRawSighash: input ${i} is not P2TR -- raw-sighash path supports key-path taproot only`
      );
    }
    prevoutScripts.push(wu.script);
    prevoutValues.push(wu.value);
  }

  // Reach into the PSBT's cached unsigned transaction. We use the
  // same shape `bip322.ts` does -- v6/v7 bitcoinjs-lib keeps the
  // unsigned tx on `psbt.__CACHE.__TX` and exposes
  // `hashForWitnessV1` on it. We treat this as semi-private API
  // (hence the cast) because the `Psbt` class doesn't surface
  // sighash computation publicly.
  const unsignedTx = (psbt as any).__CACHE?.__TX;
  if (!unsignedTx || typeof unsignedTx.hashForWitnessV1 !== "function") {
    throw new Error(
      "signPsbtViaRawSighash: PSBT did not expose a cached unsigned transaction"
    );
  }

  for (let i = 0; i < inputCount; i++) {
    // SIGHASH_DEFAULT (0x00) -- matches what Turnkey produces for
    // a Schnorr signature over a 32-byte digest, and what we want
    // anyway because it's the cheapest taproot sighash (no
    // 1-byte type suffix on the witness).
    const sighashType = 0x00;
    // bitcoinjs-lib v7 returns Uint8Array; v6 returned Buffer.
    // Accept either by reading length, then normalize to a hex
    // string for the callback.
    const digestRaw: Uint8Array = unsignedTx.hashForWitnessV1(
      i,
      prevoutScripts,
      prevoutValues,
      sighashType
    );
    if (!digestRaw || digestRaw.length !== 32) {
      throw new Error(
        `signPsbtViaRawSighash: bad sighash digest for input ${i} (got ${digestRaw?.length ?? "n/a"} bytes)`
      );
    }

    const sigHex = await sign32(Buffer.from(digestRaw).toString("hex"));
    const sigBytes = Buffer.from(sigHex, "hex");
    if (sigBytes.length !== 64) {
      throw new Error(
        `signPsbtViaRawSighash: sign32 returned ${sigBytes.length} bytes for input ${i} (want 64)`
      );
    }

    // Stuff the schnorr signature into `tapKeySig`. bitcoinjs-lib's
    // `finalizeAllInputs()` (called by our existing
    // `finalizeSignedPsbt`) reads this field to construct the
    // input's final witness: a single-element witness stack
    // containing exactly the 64-byte sig (or 65 with the sighash
    // type suffix; we picked 0x00 so it's 64).
    psbt.updateInput(i, { tapKeySig: sigBytes });
  }

  return psbt;
}
