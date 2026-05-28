/**
 * Signer adapter -- bridges a wallet's `signArchMessageHash(messageHashHex)`
 * primitive to the `(challenge: string) => Promise<string>` callback shape
 * arch-swap's `transaction-runner.ts` consumes.
 *
 * Where the bytes come from
 * -------------------------
 * arch-swap's `transaction-runner` does:
 *
 *     const hashBytes = SanitizedMessageUtil.hash(message);
 *     const challenge = new TextDecoder().decode(hashBytes);
 *     const rawSig = await signer(challenge);
 *
 * In current `@saturnbtcio/arch-sdk`, `SanitizedMessageUtil.hash` already
 * returns the UTF-8 encoding of a lowercase 64-char hex string (see
 * `sanitized-message.ts` → `return new TextEncoder().encode(hex.encode(finalHash))`).
 * `TextDecoder().decode` on that is therefore lossless: `challenge` IS the
 * 64-char hex string.
 *
 * On the verifier side, Arch reproduces those same 64 UTF-8 bytes and
 * BIP-322-verifies over them. The wallet's `signArchMessageHash` interprets
 * `messageHashHex` as the hex string and passes it straight to bip322-js,
 * which UTF-8-encodes it via `Buffer.from(message)` -- giving exactly the
 * same 64 bytes the verifier signs over. So this adapter just forwards
 * `challenge` unchanged.
 *
 * Historical note: an earlier version of this adapter double-encoded the
 * challenge (hex(UTF-8(challenge)) → 128 chars) and relied on the wallet
 * unwrapping via `hexToBytes` to recover the verifier's bytes. The wallet
 * later switched to the canonical "treat messageHashHex as a string and
 * UTF-8-encode it" convention used by `bip322-js.Signer.sign(wif, addr,
 * hexString)`. After that switch, the double-encoded path BIP-322-signed
 * the wrong byte length and Arch rejected the submission with
 * `"BIP322 signature verification failed: Invalid signature"`. Passing the
 * challenge through verbatim is what now matches the verifier.
 */

import { Witness } from "@saturnbtcio/bip322-js";
import type { TransactionSigner } from "./lib/arch/transaction-runner";

/**
 * Minimal interface the host wallet must implement. The chrome-wallet's
 * `Signer` (in `apps/chrome-wallet/src/signers/Signer.ts`) already satisfies
 * this. `messageHashHex` is the lowercase hex string of the message hash;
 * the wallet UTF-8-encodes it for BIP-322 (the convention `bip322-js`'s
 * `Signer.sign` and the on-chain Arch validator agree on).
 */
export interface WalletDigestSigner {
  signArchMessageHash(opts: { messageHashHex: string }): Promise<{ signature64Hex: string }>;
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
    const { signature64Hex } = await walletSigner.signArchMessageHash({
      messageHashHex: challenge,
    });
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
