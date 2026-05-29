/**
 * UTXO protection model.
 *
 * A BTC output is "protected" when consuming it would destroy a
 * Bitcoin-anchored asset:
 *   - an Ordinal inscription (the inscription burns with the output's
 *     first sat moving to fees or the wrong recipient)
 *   - any rune balance (confirmed via `runes`)
 *   - any mempool-pending rune balance (via `risky_runes`) that hasn't
 *     finalized yet -- treating these as protected is a deliberate
 *     conservative choice; including them in coin selection would
 *     enable front-runners to invalidate the user's send
 *
 * This module is intentionally side-effect-free and synchronous so
 * the same helpers can be used by selectUtxos (hot path), Dashboard
 * balance display, and tests with mocked UTXO arrays.
 *
 * Mainnet fallback: when the upstream indexer hasn't enriched UTXOs
 * yet (no inscriptions / runes / risky_runes fields), every UTXO is
 * treated as plain BTC. This is the "safe mode" for installs where
 * mainnet sync is still in progress -- worse-case behavior matches
 * the pre-protection wallet exactly.
 */
import type { BtcUtxo } from "./indexer";

/**
 * Why a UTXO is locked, as a discriminated union. Used by the UI to
 * render "X.YZ BTC locked in 2 inscriptions and 1 rune balance"
 * style copy without re-walking the protection arrays.
 */
export type ProtectionReason =
  | { kind: "inscription"; count: number }
  | { kind: "rune"; count: number }
  | { kind: "risky_rune"; count: number };

function inscriptionCount(utxo: BtcUtxo): number {
  const arr = utxo.inscriptions;
  return Array.isArray(arr) ? arr.length : 0;
}

function nonZeroRuneCount(runes: BtcUtxo["runes"]): number {
  if (!Array.isArray(runes)) return 0;
  // Defensive: filter out zero-balance rune entries. The indexer
  // doesn't ship these today (verified on testnet), but a 0-amount
  // entry would otherwise lock a plain UTXO. BigInt cast keeps us
  // safe for u128 amounts encoded as decimal strings.
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
 * Returns true if the UTXO carries inscriptions, confirmed runes, or
 * mempool-pending runes that haven't finalized. The wallet must NOT
 * include such UTXOs in default coin selection.
 */
export function isProtectedUtxo(utxo: BtcUtxo): boolean {
  return (
    inscriptionCount(utxo) > 0 ||
    nonZeroRuneCount(utxo.runes) > 0 ||
    nonZeroRuneCount(utxo.risky_runes) > 0
  );
}

/**
 * Returns the list of distinct reasons this UTXO is protected. Order
 * is stable: inscription -> rune -> risky_rune. Returns an empty
 * array for plain UTXOs.
 */
export function reasonsForUtxo(utxo: BtcUtxo): ProtectionReason[] {
  const out: ProtectionReason[] = [];
  const insc = inscriptionCount(utxo);
  if (insc > 0) out.push({ kind: "inscription", count: insc });
  const runes = nonZeroRuneCount(utxo.runes);
  if (runes > 0) out.push({ kind: "rune", count: runes });
  const risky = nonZeroRuneCount(utxo.risky_runes);
  if (risky > 0) out.push({ kind: "risky_rune", count: risky });
  return out;
}

export interface PartitionedUtxos {
  spendable: BtcUtxo[];
  protected_: BtcUtxo[];
  spendableSats: number;
  protectedSats: number;
}

/**
 * Split a UTXO array into spendable vs protected. Returns sats sums
 * for each side so callers (Dashboard balance, Send MAX) don't have
 * to reduce twice.
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
