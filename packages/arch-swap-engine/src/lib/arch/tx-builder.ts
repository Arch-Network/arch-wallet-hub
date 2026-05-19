// Compile a list of instructions into a signed-shape `RuntimeTransaction`,
// plus the SDK ↔ runtime-transaction normalisation helpers that wrap every
// inbound/outbound tx on the wire.
//
// Hex and integer-encoding primitives live in `@/arch/hex` and
// `@/arch/borsh` respectively.

import { SanitizedMessageUtil } from "@saturnbtcio/arch-sdk";

import { fetchBestBlockHash } from "@/lib/indexer/blocks";
import { hexToBytes } from "@/lib/arch/hex";
import type { RuntimeMessage, RuntimeTransaction, ProcessedTransaction } from "@/lib/arch/types";

// ── Array conversion helpers ───────────────────────────────────────────────

export function toNumberArray(value: unknown): number[] {
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => Number(item) || 0);
  }
  return [];
}

// ── SDK ↔ RuntimeTransaction conversion ────────────────────────────────────

export type SdkRuntimeTransaction = {
  version: number;
  signatures: Uint8Array[];
  message: {
    header: RuntimeMessage["header"];
    account_keys: Uint8Array[];
    recent_blockhash: Uint8Array;
    instructions: Array<{
      program_id_index: number;
      accounts: number[];
      data: Uint8Array;
    }>;
  };
};

export function normalizeRuntimeTransaction(value: unknown): RuntimeTransaction {
  const tx = (value ?? {}) as {
    version?: unknown;
    signatures?: unknown;
    message?: {
      header?: RuntimeMessage["header"];
      account_keys?: unknown;
      recent_blockhash?: unknown;
      instructions?: Array<{
        program_id_index?: unknown;
        accounts?: unknown;
        data?: unknown;
      }>;
    };
  };

  return {
    version: typeof tx.version === "number" ? tx.version : 0,
    signatures: Array.isArray(tx.signatures) ? tx.signatures.map((sig) => toNumberArray(sig)) : [],
    message: {
      header: tx.message?.header ?? {
        num_required_signatures: 0,
        num_readonly_signed_accounts: 0,
        num_readonly_unsigned_accounts: 0,
      },
      account_keys: Array.isArray(tx.message?.account_keys) ? tx.message.account_keys.map((key) => toNumberArray(key)) : [],
      recent_blockhash: toNumberArray(tx.message?.recent_blockhash),
      instructions: Array.isArray(tx.message?.instructions)
        ? tx.message.instructions.map((ix) => ({
            program_id_index: typeof ix.program_id_index === "number" ? ix.program_id_index : 0,
            accounts: Array.isArray(ix.accounts) ? ix.accounts.map((account) => Number(account) || 0) : [],
            data: toNumberArray(ix.data),
          }))
        : [],
    },
  };
}

export function toSdkRuntimeTransaction(tx: RuntimeTransaction): SdkRuntimeTransaction {
  return {
    version: tx.version ?? 0,
    signatures: tx.signatures.map((sig) => Uint8Array.from(sig)),
    message: {
      header: tx.message.header,
      account_keys: tx.message.account_keys.map((key) => Uint8Array.from(key)),
      recent_blockhash: Uint8Array.from(tx.message.recent_blockhash),
      instructions: tx.message.instructions.map((ix) => ({
        program_id_index: ix.program_id_index,
        accounts: ix.accounts,
        data: Uint8Array.from(ix.data),
      })),
    },
  };
}

export function normalizeProcessedTransaction(value: unknown): ProcessedTransaction {
  const tx = (value ?? {}) as {
    runtime_transaction?: unknown;
    status?: { type?: "processing" | "processed" | "failed"; message?: unknown };
    bitcoin_txid?: unknown;
    logs?: unknown;
    rollback_status?: { type?: "notRolledback" | "rolledback"; message?: unknown };
    inner_instructions_list?: unknown;
  };

  const statusType = tx.status?.type === "failed" ? "failed" : tx.status?.type === "processing" ? "processing" : "processed";
  const rollbackType = tx.rollback_status?.type === "rolledback" ? "rolledback" : "notRolledback";

  return {
    runtime_transaction: normalizeRuntimeTransaction(tx.runtime_transaction),
    status:
      statusType === "failed"
        ? {
            type: "failed",
            message: typeof tx.status?.message === "string" ? tx.status.message : "Transaction failed",
          }
        : { type: statusType },
    bitcoin_txid: tx.bitcoin_txid == null ? null : toNumberArray(tx.bitcoin_txid),
    logs: Array.isArray(tx.logs) ? tx.logs.filter((line): line is string => typeof line === "string") : [],
    rollback_status:
      rollbackType === "rolledback"
        ? {
            type: "rolledback",
            message: typeof tx.rollback_status?.message === "string" ? tx.rollback_status.message : "Rolled back",
          }
        : { type: "notRolledback" },
    inner_instructions_list: tx.inner_instructions_list,
  };
}

// ── Transaction building helper ────────────────────────────────────────────

export type SdkInstruction = {
  program_id: Uint8Array;
  accounts: Array<{
    pubkey: Uint8Array;
    is_signer: boolean;
    is_writable: boolean;
  }>;
  data: Uint8Array;
};

export async function buildTransaction(
  instructions: SdkInstruction[],
  signerPubkey: Uint8Array,
): Promise<RuntimeTransaction> {
  const blockhashHex = await fetchBestBlockHash();
  const blockhashBytes = hexToBytes(blockhashHex);

  const messageResult = SanitizedMessageUtil.createSanitizedMessage(
    instructions,
    signerPubkey,
    blockhashBytes,
  );

  if (typeof messageResult === "string") {
    throw new Error(`Failed to compile transaction: ${messageResult}`);
  }

  const sdkTx = { version: 0, signatures: [] as Uint8Array[], message: messageResult };
  return normalizeRuntimeTransaction(sdkTx);
}
