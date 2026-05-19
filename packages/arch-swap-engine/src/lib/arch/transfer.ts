import { PubkeyUtil } from "@saturnbtcio/arch-sdk";

import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@/lib/arch/program-ids";
import { fetchAccountInfo } from "@/lib/indexer/accounts";
import { hexToBytes } from "@/lib/arch/hex";
import { encodeU64LE } from "@/lib/arch/borsh";
import {
  buildTransaction,
  type SdkInstruction,
} from "@/lib/arch/tx-builder";
import type { RuntimeTransaction } from "@/lib/arch/types";
import type { NetworkConfig, TokenSymbol } from "@/lib/network/config";

const SYSTEM_PROGRAM_ID = new Uint8Array(32);

function resolveMint(config: NetworkConfig, symbol: string): string | undefined {
  return config.tokens[symbol as TokenSymbol]?.mint;
}

/**
 * Build an SPL token transfer transaction.
 *
 * If the recipient's ATA does not exist yet, a create-ATA instruction is
 * prepended so the transfer can succeed in a single transaction.
 *
 * @param senderPubkeyHex    - 64-char hex x-only pubkey of the sender
 * @param recipientPubkeyHex - 64-char hex x-only pubkey of the recipient
 * @param tokenSymbol        - "BTC" or "USDT"
 * @param amount             - raw token amount (already scaled to decimals)
 */
export async function buildTransferTransaction(
  config: NetworkConfig,
  senderPubkeyHex: string,
  recipientPubkeyHex: string,
  tokenSymbol: string,
  amount: bigint,
): Promise<RuntimeTransaction> {
  const mintHex = resolveMint(config, tokenSymbol);
  if (!mintHex) {
    throw new Error(`Unsupported token for transfer: ${tokenSymbol}`);
  }

  const mintBytes = hexToBytes(mintHex);
  const senderPubkey = hexToBytes(senderPubkeyHex);
  const recipientPubkey = hexToBytes(recipientPubkeyHex);

  const senderAta = PubkeyUtil.getAssociatedTokenAddress(
    mintBytes,
    senderPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const recipientAta = PubkeyUtil.getAssociatedTokenAddress(
    mintBytes,
    recipientPubkey,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const instructions: SdkInstruction[] = [];

  // Check if recipient ATA exists; if not, the create-ATA instruction
  // gets prepended below so the transfer can succeed in one transaction.
  // A null result (or thrown `-32002 not found`) both mean "not indexed."
  const recipientAtaInfo = await fetchAccountInfo(recipientAta).catch(() => null);
  const recipientAtaExists = recipientAtaInfo !== null;

  if (!recipientAtaExists) {
    instructions.push({
      program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
      accounts: [
        { pubkey: senderPubkey, is_signer: true, is_writable: true },
        { pubkey: recipientAta, is_signer: false, is_writable: true },
        { pubkey: recipientPubkey, is_signer: false, is_writable: false },
        { pubkey: mintBytes, is_signer: false, is_writable: false },
        { pubkey: SYSTEM_PROGRAM_ID, is_signer: false, is_writable: false },
        { pubkey: TOKEN_PROGRAM_ID, is_signer: false, is_writable: false },
      ],
      data: new Uint8Array([]),
    });
  }

  // SPL Transfer instruction: opcode 3 + u64 LE amount
  const transferData = new Uint8Array(9);
  transferData[0] = 3;
  transferData.set(new Uint8Array(encodeU64LE(amount)), 1);

  instructions.push({
    program_id: TOKEN_PROGRAM_ID,
    accounts: [
      { pubkey: senderAta, is_signer: false, is_writable: true },
      { pubkey: recipientAta, is_signer: false, is_writable: true },
      { pubkey: senderPubkey, is_signer: true, is_writable: false },
    ],
    data: transferData,
  });

  return buildTransaction(instructions, senderPubkey);
}
