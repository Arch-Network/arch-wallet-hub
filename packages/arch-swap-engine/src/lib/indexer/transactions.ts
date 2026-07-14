import { IndexerRpcError, indexerRpc } from "@/lib/indexer/client";
import type { ProcessedTransaction, RuntimeTransaction } from "@/lib/arch/types";

/**
 * Submit a signed runtime transaction. Returns the txid emitted by the
 * validator. Throws `IndexerRpcError` on failure, including validator-side
 * rejections forwarded verbatim through the indexer.
 */
export async function submitTransaction(tx: RuntimeTransaction): Promise<string> {
  return indexerRpc<string>("send_transaction", tx);
}

/**
 * Fetch the on-chain status of a previously-submitted transaction.
 * Returns `null` when neither the indexer nor the validator has a record
 * yet — treat as "still pending."
 */
export async function fetchTransactionStatus(
  txid: string,
): Promise<ProcessedTransaction | null> {
  return indexerRpc<ProcessedTransaction | null>(
    "get_processed_transaction",
    { tx_id: txid },
  );
}

/**
 * Lifecycle label derived from a `ProcessedTransaction`.
 *
 *   `pending`     — indexer/validator hasn't seen the tx yet
 *   `processing`  — seen, not yet finalised
 *   `processed`   — finalised successfully
 *   `failed`      — rejected on chain
 */
export type ChainStatus = "pending" | "processing" | "processed" | "failed";

/**
 * Map a status response to a `ChainStatus`.
 *
 * Accepts the indexer's PascalCase (`Processed`, `Failed`, `Queued`) and
 * the validator's lowercase wire format. Unrecognized statuses map to
 * `processing` so callers keep polling rather than terminating early.
 */
export function classifyTransactionStatus(
  tx: ProcessedTransaction | null,
): ChainStatus {
  if (!tx) return "pending";
  const t = tx.status?.type?.toLowerCase();
  if (t === "processed") return "processed";
  if (t === "failed") return "failed";
  return "processing";
}

/**
 * Pull the human-readable failure reason out of a failed
 * `ProcessedTransaction`. Returns `null` for any non-failed status.
 */
export function getFailureReason(tx: ProcessedTransaction | null): string | null {
  if (!tx) return null;
  if (tx.status?.type?.toLowerCase() !== "failed") return null;
  const failed = tx.status as { type: string; message?: string };
  return failed.message ?? "Transaction failed on chain";
}

const CONFIRM_POLL_INTERVAL_MS = 2_000;
const CONFIRM_MAX_ATTEMPTS = 30; // ≈ 60s budget at 2s intervals

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll until the given txid resolves to `processed` or `failed`.
 * Resolves void on success, throws on chain-side failure or after the
 * poll budget is exhausted. Transport errors fold into the shared
 * retry budget — only sustained unreachability across the full window
 * surfaces as a failure.
 */
export async function waitForConfirmation(txid: string): Promise<void> {
  let lastTransportError: unknown = null;

  for (let attempt = 1; attempt <= CONFIRM_MAX_ATTEMPTS; attempt += 1) {
    await sleep(CONFIRM_POLL_INTERVAL_MS);

    let result: ProcessedTransaction | null;
    try {
      result = await fetchTransactionStatus(txid);
      lastTransportError = null;
    } catch (err) {
      lastTransportError = err;
      // -32602 here is a known indexer-side hybrid-forward bug during
      // the pending window; the next poll usually succeeds. Suppress
      // the warn so the console only reflects actionable anomalies.
      const isKnownIndexerForwardBug =
        err instanceof IndexerRpcError && err.code === -32602;
      if (!isKnownIndexerForwardBug) {
        console.warn(
          `waitForConfirmation transport error (attempt ${attempt}/${CONFIRM_MAX_ATTEMPTS})`,
          err,
        );
      }
      continue;
    }

    const status = classifyTransactionStatus(result);
    if (status === "processed") return;
    if (status === "failed") {
      // Log the full `ProcessedTransaction` — the toast surfaces only
      // the one-line reason, but `logs`, `rollback_status`, and the
      // instruction tree are what diagnose a program error.
      console.error("[indexer] Transaction failed on chain", {
        txid,
        reason: getFailureReason(result),
        result,
      });
      throw new Error(
        getFailureReason(result) ?? "Transaction failed on chain",
      );
    }
  }

  if (lastTransportError) {
    console.error("[indexer] Confirmation poll exhausted with transport errors", {
      txid,
      attempts: CONFIRM_MAX_ATTEMPTS,
      lastError: lastTransportError,
    });
    const message =
      lastTransportError instanceof Error
        ? lastTransportError.message
        : String(lastTransportError);
    throw new Error(`Indexer unreachable for ${txid}: ${message}`);
  }
  console.error("[indexer] Transaction not confirmed in time", {
    txid,
    attempts: CONFIRM_MAX_ATTEMPTS,
    totalWaitMs: CONFIRM_MAX_ATTEMPTS * CONFIRM_POLL_INTERVAL_MS,
  });
  throw new Error(
    `Transaction ${txid} not confirmed in ${Math.round(
      (CONFIRM_MAX_ATTEMPTS * CONFIRM_POLL_INTERVAL_MS) / 1000,
    )}s`,
  );
}

/**
 * Submit a runtime transaction and wait for it to confirm. Returns the
 * txid emitted by the validator.
 */
export async function submitAndConfirm(tx: RuntimeTransaction): Promise<string> {
  const txid = await submitTransaction(tx);
  await waitForConfirmation(txid);
  return txid;
}

/**
 * Build a faucet-funded create-account transaction. The returned tx
 * already has the faucet's signature at position 0; the caller adds
 * the account-key signature and submits.
 *
 * Wire format: `create_account_with_faucet(pubkey: Pubkey)` where
 * `Pubkey` serialises as a flat 32-element u8 array — so `params` is
 * the byte array directly, not wrapped in a positional array.
 */
export async function buildCreateAccountWithFaucetTransaction(
  pubkey: Uint8Array,
): Promise<RuntimeTransaction> {
  return indexerRpc<RuntimeTransaction>(
    "create_account_with_faucet",
    Array.from(pubkey),
  );
}
