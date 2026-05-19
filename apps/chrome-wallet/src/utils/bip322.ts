/**
 * BIP-322 helpers, ported from `services/wallet-hub-api/src/bitcoin/bip322.ts`
 * for use inside the extension popup / service worker.
 *
 * Why we have this:
 *   Arch L2 transactions are authorized by a BIP-322 signature over the
 *   sanitized message hash. The Hub already implements this for custodial
 *   signing; this module brings the same primitives into the extension so
 *   passkey-backed accounts can sign Arch payloads locally without a Hub
 *   round-trip.
 *
 * Version safety:
 *   `@saturnbtcio/bip322-js` v3 depends on `bitcoinjs-lib` v6, while the
 *   extension's top-level dependency is v7. We deliberately route ALL Psbt /
 *   Transaction operations through bip322-js's exports (which use its nested
 *   v6) so we never mix Psbt class instances across versions. The only thing
 *   we touch from top-level bitcoinjs-lib is the pure `address.fromBech32`
 *   decoder, which is byte-identical between v6 and v7.
 */

import { Address, BIP322, Verifier } from "@saturnbtcio/bip322-js";
import { address as btcAddress } from "bitcoinjs-lib";

/** Render bytes as a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array | number[] | Buffer): string {
  const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Parse a hex string into a Uint8Array. Accepts an optional `0x` prefix. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hexToBytes: odd-length input");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Extract the 32-byte x-only public key from a Taproot bech32m address
 * (`bc1p...` / `tb1p...`). Throws if the address isn't a valid P2TR output.
 */
function xOnlyPubkeyFromTaprootAddress(taprootAddress: string): Uint8Array {
  const decoded = btcAddress.fromBech32(taprootAddress);
  if (decoded.version !== 1 || decoded.data.length !== 32) {
    throw new Error(
      "Invalid Taproot address for BIP-322 signing (must be bech32m v1 with 32-byte witness program)",
    );
  }
  return new Uint8Array(decoded.data);
}

/**
 * Compute the Taproot key-path sighash for the BIP-322 `toSign` transaction
 * over `message`, using `signerAddress` as both the signer and the implied
 * prevout script. Returns a 32-byte digest.
 *
 * Pass the resulting digest to `signRawPayload` with
 * `hashFunction = HASH_FUNCTION_NO_OP, encoding = PAYLOAD_ENCODING_HEXADECIMAL`
 * (Schnorr/Taproot) — the resulting 64-byte (r || s) Schnorr signature is what
 * Arch's runtime accepts as a BIP-322-equivalent signature.
 */
export function computeBip322ToSignTaprootSighash(params: {
  signerAddress: string;
  message: string | Uint8Array;
  /**
   * BIP-341 sighash type. Defaults to `SIGHASH_DEFAULT` (0x00), which is
   * what Turnkey produces when signing a 32-byte digest via SIGN_RAW_PAYLOAD
   * with Schnorr/Taproot. That's the only path Arch validators accept today
   * (64-byte Schnorr sig). The parameter exists so we can also exercise
   * 65-byte signatures (SIGHASH_ALL etc.) in tests.
   */
  sighashType?: number;
}): Uint8Array {
  const scriptPubKey = Address.convertAdressToScriptPubkey(params.signerAddress);
  const messageInput = params.message;

  // Build to-spend so the to-sign tx pins the right prevout.
  // bip322-js accepts string | Buffer; pass Buffer when caller hands us bytes.
  const messageForLib =
    typeof messageInput === "string" ? messageInput : Buffer.from(messageInput);
  BIP322.buildToSpendTx(messageForLib, scriptPubKey); // side effect: validates inputs

  const tapInternalKey = Buffer.from(xOnlyPubkeyFromTaprootAddress(params.signerAddress));
  const toSpend = BIP322.buildToSpendTx(messageForLib, scriptPubKey);
  const toSign = BIP322.buildToSignTx(toSpend.getId(), scriptPubKey, false, tapInternalKey);

  // Replicate Verifier.getHashForSigP2TR exactly, but without going through
  // `extractTransaction()` -- that throws "Not finalized" on the unsigned
  // PSBT we have here. The Hub helper hits the same edge case and uses the
  // PSBT's internal cached transaction (`__CACHE.__TX`) as the fallback.
  //
  // `hashForWitnessV1(0, [prevoutScript], [prevoutValue=0], SIGHASH_DEFAULT)`
  // is the exact computation the bip322-js Verifier performs (Verifier.js:308)
  // and what an Arch validator will reproduce when verifying our signature.
  const witnessUtxoScript = (toSign as any).data?.inputs?.[0]?.witnessUtxo?.script;
  if (!witnessUtxoScript) {
    throw new Error("BIP-322 toSign PSBT missing witnessUtxo.script for input 0");
  }
  const cachedTx = (toSign as any).__CACHE?.__TX;
  if (!cachedTx || typeof cachedTx.hashForWitnessV1 !== "function") {
    throw new Error("BIP-322 toSign PSBT did not expose a cached unsigned transaction");
  }
  const sighashType = params.sighashType ?? 0x00;
  const digest: Buffer = cachedTx.hashForWitnessV1(
    0,
    [witnessUtxoScript],
    [0],
    sighashType,
  );
  return new Uint8Array(digest);
}

// Re-export Verifier so callers can do their own bip322 verification in
// tests / spike harnesses without a second dependency import.
export { Verifier as Bip322Verifier };
