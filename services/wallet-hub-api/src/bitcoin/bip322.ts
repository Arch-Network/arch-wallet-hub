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

  // Arch's Rust implementation uses to_sign.unsigned_tx for SighashCache.
  // See arch-network `sdk/src/helper/bip322.rs` line 81.
  // Access the unsigned transaction directly from the PSBT's internal cache.
  // `__CACHE` is private in bitcoinjs-lib types; it exists at runtime.
  // Note: `hashForWitnessV1` doesn't use PSBT metadata - it only needs the transaction
  // and prevout script/value. The tapInternalKey is used by the PSBT for signing,
  // but the sighash computation itself only needs the scriptPubKey (which is derived
  // from the internal key and is already in the prevout script).
  const toSignTx = (psbt as any).__CACHE?.__TX as Transaction;
  if (!toSignTx) {
    throw new Error("Failed to get unsigned transaction from PSBT");
  }
  
  // Arch's Rust implementation uses to_spend_tx.output[0] for the prevout, with value 0.
  // See arch-network `sdk/src/helper/bip322.rs` line 86-89.
  const toSpendOutput = toSpend.outs[0];
  if (!toSpendOutput) {
    throw new Error("BIP-322 toSpend transaction missing output[0]");
  }
  
  const prevoutScript = toSpendOutput.script;
  const prevoutValue = 0; // BIP-322 toSpend output always has value 0

  // Arch's Rust implementation uses TapSighashType::All for Taproot key-path signing.
  // See arch-network `sdk/src/helper/bip322.rs` line 79.
  // The Rust code explicitly uses TapSighashType::All (0x01) in taproot_key_spend_signature_hash.
  const SIGHASH_ALL = 0x01;
  
  // Ensure we're using the correct input index (0) and that the prevout arrays match the input count
  // The Rust code uses Prevouts::All with a single TxOut for input 0
  const digest = toSignTx.hashForWitnessV1(
    0, // input index
    [prevoutScript], // prevoutScripts array (one per input)
    [prevoutValue], // prevoutValues array (one per input)
    SIGHASH_ALL
  );
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
