/**
 * UTXO protection model (server-side mirror of the wallet's
 * apps/chrome-wallet/src/utils/btc-protection.ts).
 *
 * A BTC output is "protected" when consuming it would destroy a
 * Bitcoin-anchored asset:
 *   - an Ordinal inscription (the inscription burns with the output's
 *     first sat moving to fees or the wrong recipient)
 *   - any confirmed rune balance (`runes`)
 *   - any mempool-pending rune balance (`risky_runes`) that hasn't
 *     finalized yet -- treating these as protected is a deliberate
 *     conservative choice; including them in coin selection would let
 *     a front-runner invalidate the user's send
 *
 * Pure / synchronous so it can be shared by coin selection and tests.
 *
 * Mainnet fallback: when the upstream indexer hasn't enriched UTXOs
 * yet (no inscriptions / runes / risky_runes fields), every UTXO is
 * treated as plain BTC -- "safe mode" whose worst case matches the
 * pre-protection behaviour exactly.
 */

export interface BtcUtxoInscription {
  id?: string;
  [k: string]: unknown;
}

/**
 * Rune balance carried by a UTXO. Amount is a decimal string because
 * the underlying value is u128 (Number is unsafe above 2^53); parse
 * with BigInt before arithmetic.
 */
export interface BtcUtxoRune {
  rune_id?: string;
  amount: string;
  [k: string]: unknown;
}

export interface BtcUtxo {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed: boolean; block_height?: number };

  /** Ordinal inscriptions present on this output (omitted on plain BTC). */
  inscriptions?: BtcUtxoInscription[];

  /** Confirmed rune balances on this output. */
  runes?: BtcUtxoRune[];

  /** Mempool-pending rune balances on this output (treat as protected). */
  risky_runes?: BtcUtxoRune[];

  [k: string]: unknown;
}

function inscriptionCount(utxo: BtcUtxo): number {
  const arr = utxo.inscriptions;
  return Array.isArray(arr) ? arr.length : 0;
}

function nonZeroRuneCount(runes: BtcUtxo["runes"]): number {
  if (!Array.isArray(runes)) return 0;
  // Defensive: filter out zero-balance rune entries so a 0-amount
  // entry can't lock a plain UTXO. BigInt keeps us safe for u128
  // amounts encoded as decimal strings.
  let n = 0;
  for (const r of runes) {
    if (!r || typeof r.amount !== "string") continue;
    try {
      if (BigInt(r.amount) > 0n) n += 1;
    } catch {
      // Garbage amount string: treat as protected (defensive).
      n += 1;
    }
  }
  return n;
}

/**
 * True if the UTXO carries inscriptions, confirmed runes, or
 * mempool-pending runes. Such UTXOs must NOT enter default coin
 * selection.
 */
export function isProtectedUtxo(utxo: BtcUtxo): boolean {
  return (
    inscriptionCount(utxo) > 0 ||
    nonZeroRuneCount(utxo.runes) > 0 ||
    nonZeroRuneCount(utxo.risky_runes) > 0
  );
}

export interface PartitionedUtxos {
  spendable: BtcUtxo[];
  protected_: BtcUtxo[];
  spendableSats: number;
  protectedSats: number;
}

/**
 * Split a UTXO array into spendable vs protected, returning sats sums
 * for each side.
 *
 * Note the field name `protected_` (trailing underscore) -- `protected`
 * is a reserved word in TS strict mode.
 */
export function partitionByProtection(utxos: BtcUtxo[]): PartitionedUtxos {
  const spendable: BtcUtxo[] = [];
  const protected_: BtcUtxo[] = [];
  let spendableSats = 0;
  let protectedSats = 0;
  for (const u of utxos) {
    if (isProtectedUtxo(u)) {
      protected_.push(u);
      protectedSats += u.value;
    } else {
      spendable.push(u);
      spendableSats += u.value;
    }
  }
  return { spendable, protected_, spendableSats, protectedSats };
}
