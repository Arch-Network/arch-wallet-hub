/**
 * BTC held by an account across all of its addresses on one network (an
 * Xverse account has a payment and an ordinals address). An address
 * whose summary couldn't be read is reported as unavailable; it never
 * contributes a zero.
 */
import type { BtcAddressSummary, IndexerClient } from "./indexer";

export interface AddressSats {
  confirmed: number;
  pending: number;
  /** Locked in inscription/rune outputs. 0 also when the indexer hasn't reported protection data. */
  protected: number;
}

export interface BtcHoldings extends AddressSats {
  byAddress: Record<string, AddressSats | null>;
  /** Addresses whose balance is unknown. */
  unavailable: string[];
}

/** Read sats from any summary shape the indexers return (Esplora stats, output list, or flat value). */
export function summarySats(summary: BtcAddressSummary): AddressSats {
  const protectedSats = typeof summary.protected_value === "number" ? summary.protected_value : 0;
  if (summary.chain_stats) {
    return {
      confirmed: (summary.chain_stats.funded_txo_sum ?? 0) - (summary.chain_stats.spent_txo_sum ?? 0),
      pending: (summary.mempool_stats?.funded_txo_sum ?? 0) - (summary.mempool_stats?.spent_txo_sum ?? 0),
      protected: protectedSats,
    };
  }
  if (Array.isArray(summary.outputs)) {
    let confirmed = 0;
    let pending = 0;
    for (const utxo of summary.outputs as any[]) {
      if (utxo.spent?.spent) continue;
      const value = Number(utxo.value ?? 0);
      if (utxo.status?.confirmed) confirmed += value;
      else pending += value;
    }
    return { confirmed, pending, protected: protectedSats };
  }
  return {
    confirmed: typeof summary.value === "number" ? summary.value : 0,
    pending: 0,
    protected: protectedSats,
  };
}

export function combineHoldings(byAddress: Record<string, AddressSats | null>): BtcHoldings {
  const total: BtcHoldings = { confirmed: 0, pending: 0, protected: 0, byAddress, unavailable: [] };
  for (const [address, sats] of Object.entries(byAddress)) {
    if (!sats) {
      total.unavailable.push(address);
      continue;
    }
    total.confirmed += sats.confirmed;
    total.pending += sats.pending;
    total.protected += sats.protected;
  }
  return total;
}

/**
 * Fetch every address's summary. `known` supplies summaries already in
 * hand (null meaning that read failed), so they aren't requested twice.
 */
export async function fetchBtcHoldings(
  indexer: Pick<IndexerClient, "getBtcAddressSummary">,
  addresses: string[],
  known: Record<string, BtcAddressSummary | null> = {},
): Promise<BtcHoldings> {
  const entries = await Promise.all(
    addresses.map(async (address): Promise<[string, AddressSats | null]> => {
      if (address in known) {
        const summary = known[address];
        return [address, summary ? summarySats(summary) : null];
      }
      try {
        return [address, summarySats(await indexer.getBtcAddressSummary(address))];
      } catch {
        return [address, null];
      }
    }),
  );
  return combineHoldings(Object.fromEntries(entries));
}
