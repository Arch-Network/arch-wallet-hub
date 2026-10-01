import bs58 from "bs58";
import { PubkeyUtil } from "@arch-network/arch-sdk";

/** Arch Token program (TokenT4em…). */
const TOKEN_PROGRAM_ID = new Uint8Array([
  6, 221, 246, 225, 185, 234, 132, 65, 44, 16, 184, 223, 2, 28, 16, 15,
  200, 135, 25, 7, 195, 9, 195, 53, 53, 222, 32, 156, 52, 23, 99, 191,
]);

/** Arch Associated Token program (ATok9px…). */
const ASSOCIATED_TOKEN_PROGRAM_ID = new Uint8Array([
  140, 151, 35, 17, 132, 146, 123, 119, 181, 241, 128, 17, 143, 204, 104, 52,
  20, 183, 124, 82, 30, 90, 119, 8, 28, 247, 29, 95, 96, 106, 83, 132,
]);

function ownerBytesFromPublicKeyHex(publicKeyHex: string): Uint8Array {
  const hex =
    publicKeyHex.length === 66 && /^(02|03)/i.test(publicKeyHex)
      ? publicKeyHex.slice(2)
      : publicKeyHex;
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("Invalid wallet public key for associated token derivation");
  }
  return new Uint8Array(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
}

/**
 * Derive the deterministic associated-token account for (mint, owner).
 * Seeds match Arch / SPL: [owner, token_program, mint] under the ATA program.
 */
export function deriveAssociatedTokenAddress(
  mintBase58: string,
  ownerPublicKeyHex: string,
): string {
  const mint = bs58.decode(mintBase58);
  if (mint.length !== 32) throw new Error("Invalid mint for associated token derivation");
  const owner = ownerBytesFromPublicKeyHex(ownerPublicKeyHex);
  const address = PubkeyUtil.getAssociatedTokenAddress(
    mint,
    owner,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return bs58.encode(address);
}
