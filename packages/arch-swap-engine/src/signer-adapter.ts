/**
 * Signer adapter -- bridges a wallet's `signArchMessageHash(messageHashHex)`
 * primitive (which is what we just proved works in the chrome-wallet spike)
 * to the `(challenge: string) => Promise<string>` callback shape arch-swap's
 * `transaction-runner.ts` consumes.
 *
 * The challenge plumbing
 * ----------------------
 * arch-swap's `transaction-runner` does:
 *
 *     const hashBytes = SanitizedMessageUtil.hash(message);   // 32 raw bytes
 *     const challenge = new TextDecoder().decode(hashBytes);   // lossy UTF-8
 *     const rawSig = await signer(challenge);                  // wallet signs
 *     return SignatureUtil.adjustSignature(...);
 *
 * On the verifier side, Arch reconstructs `messageHash` the same way and
 * re-encodes it as UTF-8 to recover bytes-the-wallet-saw. The round trip is
 * lossy for non-UTF-8 sequences (invalid bytes become \uFFFD), but both
 * sides do the same lossy dance so they agree on the byte sequence that
 * actually gets BIP-322 signed.
 *
 * We replicate that here:
 *   1. Take the `challenge` string.
 *   2. Re-encode as UTF-8 to recover the byte sequence the verifier expects.
 *   3. Hand the hex of those bytes to the wallet's `signArchMessageHash`,
 *      which internally computes the BIP-322 taproot sighash and asks
 *      Turnkey to sign it.
 *   4. Wrap the resulting 64-byte Schnorr sig as a BIP-322 simple witness
 *      blob (base64), so arch-swap's `extractSignature` recovers it via
 *      its primary `getWalletWitnessSignatureItem` path.
 *
 * A cleaner long-term path: PR arch-swap to add a hex-based signer
 * signature `(hashHex: string) => Promise<string>` and skip step 2. The
 * adapter handles the call-site translation so the upgrade is a 1-line
 * change here. Until then, this works against the production code path
 * Xverse/UniSat already use.
 */

import { Witness } from "@saturnbtcio/bip322-js";
import type { TransactionSigner } from "./lib/arch/transaction-runner";

/**
 * Minimal interface the host wallet must implement. The chrome-wallet's
 * `Signer` (in `apps/chrome-wallet/src/signers/Signer.ts`) already satisfies
 * this -- it's the `signArchMessageHash` method we added during the spike.
 */
export interface WalletDigestSigner {
  /**
   * Compute the BIP-322 SIGHASH_DEFAULT taproot sighash for the wallet's
   * own Taproot address and the given 32-byte message hash (hex), sign that
   * sighash with Turnkey, and return the 64-byte Schnorr signature as hex.
   * Throws on user rejection / Turnkey failure.
   */
  signArchMessageHash(opts: { messageHashHex: string }): Promise<{ signature64Hex: string }>;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hexToBytes: odd-length input");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function makeSwapSigner(walletSigner: WalletDigestSigner): TransactionSigner {
  return async (challenge: string): Promise<string> => {
    const messageHashBytes = new TextEncoder().encode(challenge);
    const messageHashHex = bytesToHex(messageHashBytes);

    const { signature64Hex } = await walletSigner.signArchMessageHash({ messageHashHex });
    const schnorrSig = hexToBytes(signature64Hex);
    if (schnorrSig.length !== 64) {
      throw new Error(
        `Wallet returned a ${schnorrSig.length}-byte signature; expected 64 bytes`,
      );
    }

    // BIP-322 simple witness blob (base64). arch-swap's `extractSignature`
    // recognises this format via `getWalletWitnessSignatureItem` and pulls
    // out the 64-byte Schnorr signature on the primary path -- so the raw-
    // bytes fallback never runs.
    return Witness.serialize([schnorrSig]);
  };
}
