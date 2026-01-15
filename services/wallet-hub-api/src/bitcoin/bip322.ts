import { Address, BIP322 } from "@saturnbtcio/bip322-js";
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

  // The @saturnbtcio/bip322-js Signer sets sighashType on the PSBT input before signing.
  // See Signer.js line 111-113: toSignTx.updateInput(0, { sighashType: bitcoin.Transaction.SIGHASH_ALL })
  // This is important for correct sighash computation.
  psbt.updateInput(0, {
    sighashType: 0x01 // SIGHASH_ALL
  });

  // After updating the PSBT input with sighashType, the cached transaction should still be valid
  // because sighashType is metadata and doesn't change the transaction structure.
  // However, we need to ensure we're using the correct transaction for sighash computation.
  // The @saturnbtcio/bip322-js Verifier uses extractTransaction(), but we can't do that on unsigned PSBT.
  // Instead, we access the cached unsigned transaction directly.
  // Note: The PSBT cache is built from the PSBT data, so it should reflect tapInternalKey and sighashType.
  let toSignTx = (psbt as any).__CACHE?.__TX as Transaction;
  if (!toSignTx) {
    // If cache doesn't exist, the PSBT will build it when we access it
    // Force cache construction by accessing the transaction builder
    const _ = psbt.data.globalMap.unsignedTx;
    toSignTx = (psbt as any).__CACHE?.__TX as Transaction;
    if (!toSignTx) {
      throw new Error("Failed to get unsigned transaction from PSBT");
    }
  }
  
  // The @saturnbtcio/bip322-js Verifier.getHashForSigP2TR method uses extractTransaction(),
  // but we can't extract an unsigned PSBT. However, we can replicate its exact logic:
  // See Verifier.js line 308: toSignTx.extractTransaction().hashForWitnessV1(0, [toSignTx.data.inputs[0].witnessUtxo.script], [0], hashType)
  // The key difference is that extractTransaction() might rebuild the transaction, but the cached transaction should be equivalent.
  const witnessUtxo = psbt.data.inputs[0]?.witnessUtxo;
  if (!witnessUtxo || !witnessUtxo.script) {
    throw new Error("PSBT input[0] missing witnessUtxo.script");
  }
  
  const prevoutScript = witnessUtxo.script;
  const prevoutValue = 0; // Verifier.getHashForSigP2TR uses [0] for prevoutValue (line 308)

  // The Verifier.getHashForSigP2TR accepts either SIGHASH_DEFAULT (0x00) or SIGHASH_ALL (0x01).
  // Arch's Rust implementation uses TapSighashType::All (0x01).
  // We use SIGHASH_ALL to match the Rust code and the Signer implementation.
  const SIGHASH_ALL = 0x01;
  
  // Replicate Verifier.getHashForSigP2TR exactly:
  // toSignTx.extractTransaction().hashForWitnessV1(0, [toSignTx.data.inputs[0].witnessUtxo.script], [0], hashType)
  // We use the cached transaction instead of extractTransaction() since we can't extract unsigned PSBTs.
  const digest = toSignTx.hashForWitnessV1(
    0, // input index
    [prevoutScript], // prevoutScripts array (one per input) - from witnessUtxo.script
    [prevoutValue], // prevoutValues array (one per input) - always [0] for BIP-322
    SIGHASH_ALL // hashType - SIGHASH_ALL (0x01) to match Rust
  );
  
  // Debug logging to help diagnose sighash computation issues
  if (typeof process !== "undefined" && process.env.DEBUG_BIP322) {
    console.log("[BIP322] Sighash computation debug:", {
      signerAddress: params.signerAddress,
      messageHex: Buffer.from(params.message).toString("hex"),
      xOnlyPubkeyHex: xOnlyPubkey.toString("hex"),
      prevoutScriptHex: prevoutScript.toString("hex"),
      prevoutValue,
      sighashType: SIGHASH_ALL,
      computedSighashHex: Buffer.from(digest).toString("hex"),
      toSignTxId: toSignTx.getId(),
      toSignTxInputs: toSignTx.ins.length,
      toSignTxOutputs: toSignTx.outs.length
    });
  }
  
  return Buffer.from(digest);
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
