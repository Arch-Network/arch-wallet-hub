/**
 * Coin selection for inscription (Ordinal) sends.
 *
 * The cost function differs from both plain-BTC and rune selection:
 *   - We MUST spend exactly ONE specific output -- the one carrying
 *     the inscription. Its identity is fixed (by satpoint outpoint or
 *     by the inscription id on the enriched UTXO), not chosen for
 *     value like a fungible coin.
 *   - The inscribed output is sent to the recipient WHOLE -- its full
 *     sat value becomes the recipient output. This preserves the
 *     inscription "postage" and guarantees the inscribed sat (at any
 *     offset within the output) lands in the first output, mirroring
 *     how Xverse / UniSat move inscriptions.
 *   - The network fee is therefore paid from SEPARATE plain (cardinal)
 *     BTC UTXOs, never by shaving the inscribed output. We MUST NOT
 *     touch any other inscription / rune / risky_rune output as fee
 *     fodder (Phase 1 protection).
 *
 * Two distinct failure modes the UI must distinguish:
 *   - INSCRIPTION_NOT_FOUND: the inscription isn't on any UTXO this
 *     address currently holds (already sent, stale gallery, or the
 *     indexer hasn't enriched the UTXO yet). Nothing to spend.
 *   - INSUFFICIENT_BTC_FOR_INSCRIPTION_SEND: the inscribed output is
 *     here, but there isn't enough plain BTC to cover the fee. User
 *     needs to consolidate spare BTC into this address first.
 *
 * The function is pure: no I/O, no state. Caller fetches UTXOs + a
 * fee estimate, calls this, and feeds the result into the PSBT
 * builder.
 */
import type { BtcUtxo } from "./indexer";
import { partitionByProtection } from "./btc-protection";

export interface InscriptionSelectInput {
  utxos: BtcUtxo[];
  /** Inscription id, e.g. "<64-hex-txid>i<index>". */
  inscriptionId: string;
  /**
   * Satpoint in "txid:vout:offset" form, if known. The outpoint
   * (txid:vout) is the most reliable way to locate the inscribed
   * UTXO; we fall back to matching the inscription id on enriched
   * UTXOs when the satpoint is absent.
   */
  satpoint?: string;
  /** Pre-estimated fee in sats. */
  feeSats: number;
}

export interface InscriptionSelectResult {
  /** The UTXO carrying the inscription -- always input[0]. */
  inscribedUtxo: BtcUtxo;
  /** Plain BTC UTXOs pulled in to cover the fee. */
  btcInputs: BtcUtxo[];
  /** Sat value of the inscribed output (becomes the recipient output). */
  inscribedValueSats: number;
  /** Sum of all input values in sats (inscribed + btc top-ups). */
  totalInputSats: number;
}

export class InscriptionNotFoundError extends Error {
  code = "INSCRIPTION_NOT_FOUND" as const;
  constructor(public inscriptionId: string) {
    super(`Inscription ${inscriptionId} is not on any UTXO held by this address`);
    this.name = "InscriptionNotFoundError";
  }
}

export class InsufficientBtcForInscriptionSendError extends Error {
  code = "INSUFFICIENT_BTC_FOR_INSCRIPTION_SEND" as const;
  constructor(public haveSats: number, public needSats: number) {
    super(
      `Insufficient BTC for inscription send: have ${haveSats} sats spendable, need ${needSats} sats for the fee`
    );
    this.name = "InsufficientBtcForInscriptionSendError";
  }
}

/** "txid:vout:offset" -> "txid:vout"; null if not parseable. */
function outpointFromSatpoint(satpoint?: string): string | null {
  if (!satpoint) return null;
  const parts = satpoint.split(":");
  if (parts.length < 2) return null;
  const txid = parts[0];
  const vout = Number(parts[1]);
  if (!txid || !Number.isInteger(vout) || vout < 0) return null;
  return `${txid}:${vout}`;
}

/**
 * Locate the UTXO carrying the inscription. Prefers the satpoint
 * outpoint (exact), falls back to matching the inscription id on an
 * enriched UTXO's `inscriptions` array.
 */
function findInscribedUtxo(
  utxos: BtcUtxo[],
  inscriptionId: string,
  satpoint?: string
): BtcUtxo | null {
  const outpoint = outpointFromSatpoint(satpoint);
  if (outpoint) {
    const byOutpoint = utxos.find((u) => `${u.txid}:${u.vout}` === outpoint);
    if (byOutpoint) return byOutpoint;
  }
  const byId = utxos.find(
    (u) =>
      Array.isArray(u.inscriptions) &&
      u.inscriptions.some((i) => i?.id === inscriptionId)
  );
  return byId ?? null;
}

/**
 * Select UTXOs to fund an inscription send.
 *
 * Algorithm:
 *   1. Locate the inscribed UTXO (satpoint outpoint, else id match);
 *      throw INSCRIPTION_NOT_FOUND if absent.
 *   2. The inscribed output value funds the recipient output, so the
 *      remaining budget to cover is just the fee.
 *   3. Pull plain BTC UTXOs (spendable subset, largest first) until
 *      the fee is covered; throw INSUFFICIENT_BTC_FOR_INSCRIPTION_SEND
 *      if not enough plain BTC exists.
 */
export function selectUtxosForInscriptionSend(
  input: InscriptionSelectInput
): InscriptionSelectResult {
  const { utxos, inscriptionId, satpoint, feeSats } = input;

  const inscribedUtxo = findInscribedUtxo(utxos, inscriptionId, satpoint);
  if (!inscribedUtxo) {
    throw new InscriptionNotFoundError(inscriptionId);
  }

  const inscribedValueSats = inscribedUtxo.value;

  // Plain BTC only: spendable subset (no inscriptions, no runes, no
  // risky_runes) per Phase 1 protection. The inscribed UTXO is itself
  // protected, so partitionByProtection already excludes it; de-dupe
  // defensively anyway.
  const { spendable, spendableSats } = partitionByProtection(utxos);
  const inscribedKey = `${inscribedUtxo.txid}:${inscribedUtxo.vout}`;
  const candidates = spendable
    .filter((u) => `${u.txid}:${u.vout}` !== inscribedKey)
    .slice()
    .sort((a, b) => b.value - a.value);

  const btcInputs: BtcUtxo[] = [];
  let btcInputSats = 0;
  for (const u of candidates) {
    if (btcInputSats >= feeSats) break;
    btcInputs.push(u);
    btcInputSats += u.value;
  }

  if (btcInputSats < feeSats) {
    throw new InsufficientBtcForInscriptionSendError(spendableSats, feeSats);
  }

  return {
    inscribedUtxo,
    btcInputs,
    inscribedValueSats,
    totalInputSats: inscribedValueSats + btcInputSats
  };
}
