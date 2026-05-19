import { indexerRpc } from "@/lib/indexer/client";
import { bytesToHex } from "@/lib/arch/hex";

/**
 * Most recent block hash known to the indexer, returned as a 64-char
 * lowercase hex string. Used as `recent_blockhash` when building
 * runtime transactions.
 *
 * Accepts either of the two shapes the indexer / validator have used
 * over time: a hex string, or a JSON array of 32 u8s.
 */
export async function fetchBestBlockHash(): Promise<string> {
  const raw = await indexerRpc<unknown>("get_best_block_hash", []);
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((b) => typeof b === "number")) {
    return bytesToHex(new Uint8Array(raw as number[]));
  }
  throw new Error(
    `Unexpected get_best_block_hash response shape: ${JSON.stringify(raw).slice(0, 240)}`,
  );
}
