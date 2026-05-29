/**
 * Rune coin selection for send-rune flows.
 *
 * The selection algorithm is intentionally simpler than full BTC
 * coin selection because the cost function has a different shape:
 *   - We MUST include UTXOs carrying the target rune (we're spending
 *     a runed asset, not a fungible balance)
 *   - We MAY also include plain BTC UTXOs to cover dust outputs + fee
 *   - We MUST NOT touch inscriptions or other-rune UTXOs (Phase 1
 *     protection, but applied selectively here: target rune is fine,
 *     everything else is off-limits)
 *
 * Two distinct failure modes the UI must distinguish:
 *   - INSUFFICIENT_RUNE_BALANCE: not enough of the target rune across
 *     all eligible UTXOs. Sending less, or buying more, is the fix.
 *   - INSUFFICIENT_BTC_FOR_RUNE_SEND: enough rune, but not enough plain
 *     BTC to cover the two dust outputs + transaction fee. User needs
 *     to consolidate spare BTC into this address first.
 *
 * Why we skip `risky_runes` UTXOs (UTXOs with mempool-pending rune
 * changes that haven't confirmed yet):
 *   - Spending a risky_rune output enables a chain re-org or
 *     mempool-replace to invalidate our send
 *   - The user can wait for confirmation; this is a UX inconvenience,
 *     not a hard block (the indexer marks them as risky_rune precisely
 *     so wallets can defer)
 */
import type { BtcUtxo } from "./indexer";
import { partitionByProtection } from "./btc-protection";

export interface RuneSelectInput {
  utxos: BtcUtxo[];
  /** RuneId in "block:tx" form, e.g. "73393:191" */
  targetRuneId: string;
  /** Target amount in minor units (u128 -- use BigInt) */
  targetAmount: bigint;
  /** Dust value for the recipient's rune-bearing output, typically 546 */
  recipientDustSats: number;
  /** Dust value for the sender's change output, typically 546 */
  changeDustSats: number;
  /** Pre-estimated fee in sats */
  feeSats: number;
}

export interface RuneSelectResult {
  /** UTXOs holding the target rune, ordered largest-amount-first */
  runedInputs: BtcUtxo[];
  /** Additional plain BTC UTXOs used to top up the dust+fee budget */
  btcInputs: BtcUtxo[];
  /** Sum of input values in sats */
  totalInputSats: number;
  /** Sum of target-rune amounts across selected runedInputs */
  targetRuneTotal: bigint;
  /** targetRuneTotal - targetAmount; goes to pointer output if > 0 */
  leftoverRune: bigint;
}

export class InsufficientRuneBalanceError extends Error {
  code = "INSUFFICIENT_RUNE_BALANCE" as const;
  constructor(public have: bigint, public need: bigint) {
    super(`Insufficient rune balance: have ${have}, need ${need}`);
    this.name = "InsufficientRuneBalanceError";
  }
}

export class InsufficientBtcForRuneSendError extends Error {
  code = "INSUFFICIENT_BTC_FOR_RUNE_SEND" as const;
  constructor(public haveSats: number, public needSats: number) {
    super(`Insufficient BTC for rune send: have ${haveSats} sats, need ${needSats}`);
    this.name = "InsufficientBtcForRuneSendError";
  }
}

/**
 * Sum the target rune's amount on a UTXO. Returns 0n for UTXOs
 * without the rune or with a malformed rune entry.
 *
 * BigInt math throughout: rune amounts are u128 decimal strings;
 * a Number cast would silently lose digits on large balances.
 */
export function getRuneBalanceOnUtxo(utxo: BtcUtxo, runeId: string): bigint {
  if (!Array.isArray(utxo.runes)) return 0n;
  let sum = 0n;
  for (const r of utxo.runes) {
    if (!r || r.rune_id !== runeId) continue;
    if (typeof r.amount !== "string") continue;
    try {
      sum += BigInt(r.amount);
    } catch {
      // Defensive: ignore malformed amount strings rather than throwing.
      // A bad entry shouldn't crash the entire selection.
    }
  }
  return sum;
}

/**
 * Returns true if this UTXO is eligible to provide target-rune
 * balance: it carries the target rune, has no inscriptions, and
 * has no mempool-pending rune changes.
 */
function isEligibleRunedUtxo(utxo: BtcUtxo, runeId: string): boolean {
  if (Array.isArray(utxo.inscriptions) && utxo.inscriptions.length > 0) {
    return false;
  }
  if (Array.isArray(utxo.risky_runes) && utxo.risky_runes.length > 0) {
    return false;
  }
  return getRuneBalanceOnUtxo(utxo, runeId) > 0n;
}

/**
 * Select UTXOs to fund a rune send.
 *
 * Algorithm:
 *   1. Filter UTXOs to those eligible for the target rune
 *   2. Sort by target-rune amount descending (fewer inputs)
 *   3. Pick until target-rune amount is covered; throw if not enough
 *   4. Compute BTC budget: total_input_sats - 2*dust - fee
 *   5. If under budget, pull additional plain BTC UTXOs (largest
 *      first) until covered; throw if not enough plain BTC either
 *
 * The function is pure: no I/O, no state. Caller fetches UTXOs +
 * fee estimate, calls this, and feeds the result into the PSBT
 * builder.
 */
export function selectUtxosForRuneSend(input: RuneSelectInput): RuneSelectResult {
  const { utxos, targetRuneId, targetAmount, recipientDustSats, changeDustSats, feeSats } = input;

  if (targetAmount <= 0n) {
    throw new Error("selectUtxosForRuneSend: targetAmount must be > 0");
  }

  // Step 1+2: filter + sort runed candidates.
  type Annotated = { utxo: BtcUtxo; runeAmount: bigint };
  const candidates: Annotated[] = [];
  for (const u of utxos) {
    if (!isEligibleRunedUtxo(u, targetRuneId)) continue;
    candidates.push({ utxo: u, runeAmount: getRuneBalanceOnUtxo(u, targetRuneId) });
  }
  candidates.sort((a, b) => {
    // Bigint can't be subtracted into a number; manual compare.
    if (b.runeAmount > a.runeAmount) return 1;
    if (b.runeAmount < a.runeAmount) return -1;
    return 0;
  });

  // Step 3: pick until target amount covered.
  const runedInputs: BtcUtxo[] = [];
  let targetRuneTotal = 0n;
  let totalInputSats = 0;
  for (const c of candidates) {
    runedInputs.push(c.utxo);
    targetRuneTotal += c.runeAmount;
    totalInputSats += c.utxo.value;
    if (targetRuneTotal >= targetAmount) break;
  }
  if (targetRuneTotal < targetAmount) {
    // Sum the FULL candidate pool for the error -- helps the UI
    // tell the user the true ceiling, not just what we managed
    // to bag before bailing.
    let fullPool = 0n;
    for (const c of candidates) fullPool += c.runeAmount;
    throw new InsufficientRuneBalanceError(fullPool, targetAmount);
  }

  // Step 4+5: top up plain BTC if needed.
  const needSats = recipientDustSats + changeDustSats + feeSats;
  const btcInputs: BtcUtxo[] = [];

  if (totalInputSats < needSats) {
    // Plain BTC UTXOs only: spendable subset (no inscriptions, no runes,
    // no risky_runes) per Phase 1 protection. We then ALSO de-dupe
    // any UTXO already selected as a runed input (shouldn't happen
    // because spendable excludes runes, but defensive).
    const { spendable, spendableSats } = partitionByProtection(utxos);
    const runedKeys = new Set(runedInputs.map((u) => `${u.txid}:${u.vout}`));
    const extras = spendable
      .filter((u) => !runedKeys.has(`${u.txid}:${u.vout}`))
      .slice()
      .sort((a, b) => b.value - a.value);

    for (const u of extras) {
      if (totalInputSats >= needSats) break;
      btcInputs.push(u);
      totalInputSats += u.value;
    }

    if (totalInputSats < needSats) {
      // Surface the spendable BTC ceiling so the UI can show
      // "you have X spendable BTC; need Y" specifically.
      throw new InsufficientBtcForRuneSendError(
        // Spendable + total selected so far is the actual ceiling
        // (some spendable may have been excluded because they're
        // also runed; this is the conservative number).
        spendableSats + runedInputs.reduce((s, u) => s + u.value, 0),
        needSats
      );
    }
  }

  return {
    runedInputs,
    btcInputs,
    totalInputSats,
    targetRuneTotal,
    leftoverRune: targetRuneTotal - targetAmount
  };
}
