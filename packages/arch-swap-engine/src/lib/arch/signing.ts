import { SanitizedMessageUtil, SignatureUtil } from "@saturnbtcio/arch-sdk";

import type { RuntimeMessage, RuntimeTransaction } from "@/lib/arch/types";
import { decodeRawWalletSignature, getWalletWitnessSignatureItem } from "@/lib/arch/signature";

export function toSdkMessage(message: RuntimeMessage) {
  return {
    header: message.header,
    account_keys: message.account_keys.map((key) => Uint8Array.from(key)),
    recent_blockhash: Uint8Array.from(message.recent_blockhash),
    instructions: message.instructions.map((instruction) => ({
      program_id_index: instruction.program_id_index,
      accounts: instruction.accounts,
      data: Uint8Array.from(instruction.data),
    })),
  };
}

function getSigningChallenge(message: RuntimeMessage): string {
  const hashBytes = SanitizedMessageUtil.hash(toSdkMessage(message));
  return new TextDecoder().decode(hashBytes);
}

/**
 * Extract a 64-byte Schnorr signature from a BIP-322 wallet response.
 *
 * The wallet returns a BIP-322 witness blob.  The correct path (verified with
 * Xverse and UniSat) is to pull the first witness stack item and run it
 * through the Arch SDK's `adjustSignature` normalization.
 *
 * Falls back to adjusting the raw decoded bytes if the witness stack can't be
 * parsed (e.g. a wallet that returns a plain hex/base64 signature).
 */
function extractSignature(rawSignature: string): number[] {
  const witnessItem = getWalletWitnessSignatureItem(rawSignature);

  if (witnessItem) {
    const adjusted = SignatureUtil.adjustSignature(witnessItem);
    if (adjusted.length === 64) {
      return Array.from(adjusted);
    }
  }

  // Fallback: try adjusting the raw decoded bytes directly.
  const rawBytes = decodeRawWalletSignature(rawSignature);
  const adjusted = SignatureUtil.adjustSignature(rawBytes);
  if (adjusted.length === 64) {
    return Array.from(adjusted);
  }

  throw new Error(
    `Failed to extract a valid 64-byte signature (witness=${witnessItem?.length ?? "none"}, raw=${rawBytes.length}).`,
  );
}

export async function signRuntimeTransactionWithSigner(
  tx: RuntimeTransaction,
  signer: (challenge: string) => Promise<string>,
): Promise<number[]> {
  const challenge = getSigningChallenge(tx.message);
  const rawSignature = await signer(challenge);
  return extractSignature(rawSignature);
}
