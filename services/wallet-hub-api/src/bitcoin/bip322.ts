import { Address, BIP322 } from "@saturnbtcio/bip322-js";
import { Psbt, Transaction } from "bitcoinjs-lib";

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

