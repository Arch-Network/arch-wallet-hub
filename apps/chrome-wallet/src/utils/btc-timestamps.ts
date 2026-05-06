import type { ArchIndexerClient } from "./indexer";
import { btcTxTimestampMs, timestampToMs } from "./format";

const blockTimeCache = new Map<string, number | null>();
const blockHashCache = new Map<string, string | null>();

function statusField(tx: Record<string, unknown>, key: string): unknown {
  const status = tx.status;
  if (status && typeof status === "object") {
    return (status as Record<string, unknown>)[key];
  }
  return undefined;
}

function txBlockHash(tx: Record<string, unknown>): string | null {
  const value = statusField(tx, "block_hash") ?? statusField(tx, "blockHash") ?? tx.block_hash ?? tx.blockHash;
  return typeof value === "string" && value ? value : null;
}

function txBlockHeight(tx: Record<string, unknown>): number | null {
  const value =
    statusField(tx, "block_height") ??
    statusField(tx, "blockHeight") ??
    tx.block_height ??
    tx.blockHeight;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function blockTimestampMs(block: unknown): number | null {
  const b = block as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return null;
  const header = b.header && typeof b.header === "object" ? b.header as Record<string, unknown> : null;
  return (
    timestampToMs(header?.time as string | number | undefined) ??
    timestampToMs(header?.timestamp as string | number | undefined) ??
    timestampToMs(b.time as string | number | undefined) ??
    timestampToMs(b.timestamp as string | number | undefined) ??
    null
  );
}

/**
 * The Indexer BTC transaction payload currently omits Esplora's
 * `status.block_time`. When that happens, enrich confirmed transactions from
 * the Indexer's block endpoints instead of displaying "Just now".
 */
export async function resolveBtcTxTimestampMs(
  indexer: ArchIndexerClient,
  tx: Record<string, unknown>
): Promise<number | null> {
  const direct = btcTxTimestampMs(tx);
  if (direct !== null) return direct;

  let blockHash = txBlockHash(tx);
  const blockHeight = txBlockHeight(tx);
  const networkPrefix = indexer.network;

  if (!blockHash && blockHeight !== null) {
    const heightKey = `${networkPrefix}:height:${blockHeight}`;
    if (!blockHashCache.has(heightKey)) {
      try {
        blockHashCache.set(heightKey, await indexer.getBtcBlockHashAtHeight(blockHeight));
      } catch {
        blockHashCache.set(heightKey, null);
      }
    }
    blockHash = blockHashCache.get(heightKey) ?? null;
  }

  if (!blockHash) return null;

  const blockKey = `${networkPrefix}:block:${blockHash}`;
  if (!blockTimeCache.has(blockKey)) {
    try {
      blockTimeCache.set(blockKey, blockTimestampMs(await indexer.getBtcBlock(blockHash)));
    } catch {
      blockTimeCache.set(blockKey, null);
    }
  }

  return blockTimeCache.get(blockKey) ?? null;
}
