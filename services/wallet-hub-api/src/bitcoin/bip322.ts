import { Address, BIP322 } from "@saturnbtcio/bip322-js";
import { Psbt, Transaction } from "bitcoinjs-lib";
import { Buffer } from "node:buffer";

function looksLikeBase64(s: string) {
  // Heuristic: base64 strings are typically padded and only use base64 charset.
  // This is not perfect, but good enough to branch parsing attempts.
  return /^[A-Za-z0-9+/=]+$/.test(s) && s.length % 4 === 0;
}

export function buildBip322ToSignPsbtBase64(params: {
  signerAddress: string;
  message: string | Buffer;
}) {
  const scriptPubKey = Address.convertAdressToScriptPubkey(params.signerAddress);
  const toSpend = BIP322.buildToSpendTx(params.message, scriptPubKey);
  const toSign = BIP322.buildToSignTx(toSpend.getId(), scriptPubKey);
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
  const psbtBase64 = buildBip322ToSignPsbtBase64(params);
  const psbt = Psbt.fromBase64(psbtBase64);

  // `__CACHE` is private in bitcoinjs-lib types; it exists at runtime.
  const tx = (psbt as any).__CACHE.__TX as Transaction;
  const input = psbt.data.inputs[0];
  if (!input?.witnessUtxo) {
    throw new Error("BIP-322 toSign PSBT missing witnessUtxo (required for Taproot sighash)");
  }

  const prevoutScript = Buffer.from(input.witnessUtxo.script);
  const prevoutValue = input.witnessUtxo.value;

  // Arch's BIP-322 implementation uses TapSighashType::All for Taproot key-path signing.
  // See arch-network `sdk/src/helper/bip322.rs`.
  const SIGHASH_ALL = 0x01;
  const digest = tx.hashForWitnessV1(0, [prevoutScript], [prevoutValue], SIGHASH_ALL);
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
