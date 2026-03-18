import { Address, BIP322, Verifier } from "@saturnbtcio/bip322-js";
import { Psbt, Transaction, address as btcAddress } from "bitcoinjs-lib";
import { Buffer } from "node:buffer";

function looksLikeBase64(s: string) {
  // Heuristic: base64 strings are typically padded and only use base64 charset.
  // This is not perfect, but good enough to branch parsing attempts.
  return /^[A-Za-z0-9+/=]+$/.test(s) && s.length % 4 === 0;
}

export function buildBip322ToSignPsbtBase64(params: {
  signerAddress: string;
  message: string | Buffer;
  tapInternalKey?: Buffer;
}) {
  const scriptPubKey = Address.convertAdressToScriptPubkey(params.signerAddress);
  const toSpend = BIP322.buildToSpendTx(params.message, scriptPubKey);
  // Pass tapInternalKey during construction (required for correct Taproot sighash computation)
  const toSign = BIP322.buildToSignTx(toSpend.getId(), scriptPubKey, false, params.tapInternalKey);
  return toSign.toBase64();
}

/**
 * Compute the Taproot key-path sighash for a BIP-322 toSign PSBT (SIGHASH_DEFAULT).
 *
 * This lets us ask Turnkey to sign the digest directly via SIGN_RAW_PAYLOAD, avoiding
 * Turnkey's PSBT parser limitations for non-standard BIP-322 PSBT outputs (e.g. OP_RETURN).
 */
export function computeBip322ToSignTaprootSighash(params: {
  signerAddress: string;
  message: string | Buffer;
}): Buffer {
  // Build the toSpend transaction to get the correct prevout (matches Rust implementation).
  const scriptPubKey = Address.convertAdressToScriptPubkey(params.signerAddress);
  const toSpend = BIP322.buildToSpendTx(params.message, scriptPubKey);
  
  // Extract x-only pubkey from Taproot address (needed for tapInternalKey)
  const decoded = btcAddress.fromBech32(params.signerAddress);
  if (decoded.version !== 1 || decoded.data.length !== 32) {
    throw new Error("Invalid Taproot address for BIP-322 signing (must be bech32m v1 with 32-byte witness program)");
  }
  const xOnlyPubkey = Buffer.from(decoded.data);

  // Build the toSign PSBT with tapInternalKey set during construction.
  // The @saturnbtcio/bip322-js library expects tapInternalKey to be passed to buildToSignTx
  // so it can properly set up the PSBT for Taproot signing.
  const psbtBase64 = buildBip322ToSignPsbtBase64({
    ...params,
    tapInternalKey: xOnlyPubkey
  });
  const psbt = Psbt.fromBase64(psbtBase64);

  // Verify that tapInternalKey was set correctly in the PSBT
  const psbtTapInternalKey = psbt.data.inputs[0]?.tapInternalKey;
  if (!psbtTapInternalKey || !psbtTapInternalKey.equals(xOnlyPubkey)) {
    throw new Error(`PSBT tapInternalKey mismatch: expected ${xOnlyPubkey.toString("hex")}, got ${psbtTapInternalKey?.toString("hex") ?? "undefined"}`);
  }

  // CRITICAL: For Taproot, SIGHASH_DEFAULT (0x00) and SIGHASH_ALL (0x01) produce the SAME sighash
  // per BIP-341. However, we need to match the Rust implementation exactly, which uses SIGHASH_ALL (0x01).
  // Turnkey requires SIGHASH_DEFAULT (0x00) for signing, but since the sighash is the same, this should work.
  // The Rust verifier will try both formats (64 bytes and 65 bytes with appended 0x01).
  //
  // We'll compute the sighash with SIGHASH_ALL (0x01) to match Rust, but set the PSBT sighashType
  // to SIGHASH_DEFAULT (0x00) to satisfy Turnkey's requirement. The actual sighash value will be the same.
  const existingSighashType = psbt.data.inputs[0]?.sighashType;
  // Set to SIGHASH_DEFAULT (0x00) for Turnkey, but we'll compute sighash with SIGHASH_ALL (0x01)
  // since they produce the same result for Taproot
  if (existingSighashType !== undefined && existingSighashType !== 0x00) {
    try {
      psbt.updateInput(0, {
        sighashType: 0x00 // SIGHASH_DEFAULT (Turnkey requirement)
      });
    } catch (err: any) {
      if (typeof process !== "undefined" && process.env.DEBUG_BIP322) {
        console.log("[BIP322] Could not update sighashType:", err.message, "existing:", existingSighashType);
      }
    }
  } else if (existingSighashType === undefined) {
    try {
      psbt.updateInput(0, {
        sighashType: 0x00 // SIGHASH_DEFAULT (Turnkey requirement)
      });
    } catch (err: any) {
      if (typeof process !== "undefined" && process.env.DEBUG_BIP322) {
        console.log("[BIP322] Could not set sighashType:", err.message);
      }
    }
  }

  // Use the @saturnbtcio/bip322-js Verifier's getHashForSigP2TR method directly!
  // This is the exact same method the verifier uses, so it should match what the Rust implementation expects.
  //
  // The Verifier.getHashForSigP2TR method:
  //   return toSignTx.extractTransaction().hashForWitnessV1(0, [toSignTx.data.inputs[0].witnessUtxo.script], [0], hashType);
  //
  // Key points:
  // - Uses witnessUtxo.script (NOT toSpend.outs[0].script)
  // - Uses [0] for prevout value
  // - Accepts either SIGHASH_DEFAULT (0x00) or SIGHASH_ALL (0x01)
  //
  // The Signer uses SIGHASH_ALL (0x01), but Turnkey requires SIGHASH_DEFAULT (0x00).
  // Since the Verifier accepts both and the Rust verifier tries both, we'll use SIGHASH_DEFAULT.
  try {
    // Use Verifier.getHashForSigP2TR directly - this is the most reliable approach
    // It uses extractTransaction() internally, which may fail for unsigned PSBTs, but let's try it
    const digest = (Verifier as any).getHashForSigP2TR(psbt, 0x00); // SIGHASH_DEFAULT
    return Buffer.from(digest);
  } catch (err: any) {
    // If the method fails (e.g., extractTransaction() fails on unsigned PSBT), fall back to manual computation
    // This replicates the Verifier's logic exactly
    const witnessUtxo = psbt.data.inputs[0]?.witnessUtxo;
    if (!witnessUtxo || !witnessUtxo.script) {
      throw new Error("PSBT input[0] missing witnessUtxo.script");
    }
    
    // Fallback: Replicate Verifier.getHashForSigP2TR logic manually
    // Try extractTransaction() first, then fall back to cached transaction
    let toSignTx: Transaction;
    try {
      toSignTx = psbt.extractTransaction(false);
    } catch (extractErr: any) {
      toSignTx = (psbt as any).__CACHE?.__TX as Transaction;
      if (!toSignTx) {
        throw new Error(`Failed to get transaction from PSBT: ${extractErr.message}`);
      }
    }
    
    // Replicate Verifier.getHashForSigP2TR exactly (line 308)
    const prevoutScript = witnessUtxo.script;
    const prevoutValue = 0;
    const SIGHASH_DEFAULT = 0x00;
    
    const digest = toSignTx.hashForWitnessV1(
      0,
      [prevoutScript],
      [prevoutValue],
      SIGHASH_DEFAULT
    );
    
    return Buffer.from(digest);
  }
}

export function extractBip322TaprootSignature64(params: {
  signedTransaction: string;
}): Buffer {
  const signed = params.signedTransaction;

  // Turnkey may return either a signed raw tx (hex) or a signed PSBT (base64).
  // We accept both and extract the witness signature from input 0.
  let tx: Transaction;

  if (looksLikeBase64(signed)) {
    const psbt = Psbt.fromBase64(signed);
    tx = psbt.extractTransaction();
  } else {
    tx = Transaction.fromHex(signed);
  }

  const witness = tx.ins[0]?.witness;
  if (!witness || witness.length < 1) {
    throw new Error("Signed Bitcoin transaction has no witness to extract");
  }

  const sigWithOptionalSighash = witness[0];
  if (sigWithOptionalSighash.length < 64) {
    throw new Error(
      `Unexpected Taproot signature length: ${sigWithOptionalSighash.length}`
    );
  }

  // Arch network expects exactly 64 bytes; it will optionally append/try SIGHASH_ALL during verification.
  return Buffer.from(sigWithOptionalSighash.subarray(0, 64));
}
