import type { RuntimeTransaction } from "@/lib/arch/types";
import { signRuntimeTransactionWithSigner } from "@/lib/arch/signing";
import { submitAndConfirm } from "@/lib/indexer/transactions";
import { createDebugLogger } from "@/lib/utils/debug-logger";

export type TransactionSigner = (challenge: string) => Promise<string>;

export type StatusCallback = (status: string) => void;

/**
 * How the user's signature combines with any signatures already attached to
 * the transaction.
 *
 * - `"replace"` (default): submit with only the user's signature. Use this
 *   for transactions built locally that arrive at the runner unsigned.
 * - `"prepend"`: place the user's signature in slot 0 and preserve any
 *   pre-existing signatures after it. Use this for protocol-attested
 *   transactions (e.g. AMM quotes that ship with the program's signatures
 *   pre-populated). Caller is responsible for ensuring the signer order
 *   matches `message.account_keys`.
 */
export type SignaturePlacement = "replace" | "prepend";

type RunnerOptions = {
  /** Human-readable label used in logs, toasts, and error titles. */
  label: string;
  /** Optional logger so callers can correlate phases with their own scope. */
  logger?: ReturnType<typeof createDebugLogger>;
  /** Status hook — fires the canonical phase strings recognised by callers. */
  onStatus?: StatusCallback;
  /** Strategy for combining the user signature with prior signatures (default: `"replace"`). */
  signaturePlacement?: SignaturePlacement;
};

const defaultLogger = createDebugLogger("ArchTx");

function composeSignatures(
  userSignature: number[],
  existing: number[][],
  placement: SignaturePlacement,
): number[][] {
  return placement === "prepend" ? [userSignature, ...existing] : [userSignature];
}

/**
 * Sign a prebuilt runtime transaction and submit it to the Arch RPC, emitting
 * the canonical two-phase status strings ("Requesting signature..." /
 * "Submitting transaction...") that caller hooks parse into their own phase
 * enums.
 *
 * Returns the confirmed transaction hash. Throws on wallet rejection, signing
 * failure, or submission failure — callers are responsible for converting
 * thrown errors into a user-facing message via `classifyTransactionError`.
 */
export async function signAndSendTransaction(
  tx: RuntimeTransaction,
  signer: TransactionSigner,
  {
    label,
    logger = defaultLogger,
    onStatus,
    signaturePlacement = "replace",
  }: RunnerOptions,
): Promise<string> {
  logger.log(`${label} — signing`, {
    signatureCount: tx.signatures.length,
    instructionCount: tx.message.instructions.length,
    accountKeyCount: tx.message.account_keys.length,
    signaturePlacement,
  });

  onStatus?.("Requesting signature...");
  const sigStart = performance.now();
  const signature = await signRuntimeTransactionWithSigner(tx, signer);
  const sigDurationMs = Math.round(performance.now() - sigStart);
  logger.log(`${label} — signed`, {
    sigDurationMs,
    signatureLength: signature.length,
  });

  onStatus?.("Submitting transaction...");
  const sendStart = performance.now();
  const signedTx: RuntimeTransaction = {
    ...tx,
    signatures: composeSignatures(signature, tx.signatures, signaturePlacement),
  };
  const txHash = await submitAndConfirm(signedTx);
  const sendDurationMs = Math.round(performance.now() - sendStart);
  logger.log(`${label} — confirmed`, { txHash, sendDurationMs });

  return txHash;
}
