import type { BtcInscriptionSummary, BtcRuneTransaction, IndexerClient } from "../../utils/indexer";
import type { ActivityRowTx } from "../../components/ActivityRow";
import { truncateAddress, formatBtc } from "../../utils/format";
import { resolveBtcTxTimestampMs } from "../../utils/btc-timestamps";
import { txHasRunestone } from "../../utils/btc-tx-classify";
import { indexRuneTxsByTxid, runeRowLabel, formatRuneDelta } from "../../utils/rune-history";

export interface TxItem extends ActivityRowTx {
  /** Raw sats for BTC, kept for future USD conversion / filters. */
  amountSats?: number;
}

export function parseBtcTx(tx: any, walletAddress: string): { direction: "in" | "out" | "self" | "unknown"; amountSats: number } {
  let sentSats = 0;
  let receivedSats = 0;

  const vin = Array.isArray(tx.vin) ? tx.vin : [];
  const vout = Array.isArray(tx.vout) ? tx.vout : [];
  const inputs = Array.isArray(tx.input) ? tx.input : [];
  const outputs = Array.isArray(tx.output) ? tx.output : [];

  for (const inp of vin) {
    if (inp.prevout?.scriptpubkey_address === walletAddress) {
      sentSats += inp.prevout.value ?? 0;
    }
  }
  for (const inp of inputs) {
    if (inp.previous_output_data?.script_pubkey_address === walletAddress) {
      sentSats += inp.previous_output_data.value ?? 0;
    }
  }

  for (const out of vout) {
    if (out.scriptpubkey_address === walletAddress) {
      receivedSats += out.value ?? 0;
    }
  }
  for (const out of outputs) {
    if (out.script_pubkey_address === walletAddress) {
      receivedSats += out.value ?? 0;
    }
  }

  const isSend = sentSats > 0;
  const isSelf = isSend && receivedSats > 0 && sentSats === receivedSats + (tx.fee ?? 0);
  const netSats = isSend ? sentSats - receivedSats : receivedSats;

  const direction: TxItem["direction"] = isSelf
    ? "self"
    : isSend
      ? "out"
      : receivedSats > 0
        ? "in"
        : "unknown";

  return { direction, amountSats: netSats };
}

/**
 * Prev-output outpoints ("txid:vout") spent by a tx, across both
 * indexer shapes: Esplora-like `vin[].{txid,vout}` and the Titan-native
 * `input[].previous_output.{txid,vout}`. Used to spot a tx that spends
 * a known inscription UTXO (an inscription send).
 */
function inputOutpoints(tx: any): string[] {
  const out: string[] = [];
  for (const i of Array.isArray(tx.vin) ? tx.vin : []) {
    if (i?.txid != null && i?.vout != null) out.push(`${i.txid}:${i.vout}`);
  }
  for (const i of Array.isArray(tx.input) ? tx.input : []) {
    const po = i?.previous_output;
    if (po?.txid != null && po?.vout != null) out.push(`${po.txid}:${po.vout}`);
  }
  return out;
}

export interface RuneContext {
  byTxid: Map<string, BtcRuneTransaction>;
  divByRuneId: Map<string, number>;
}

/**
 * Rune transfer history for accurate row labels + amounts. Both
 * calls are best-effort: a failure must not hide BTC history, so
 * rune rows fall back to the local runestone heuristic.
 * `divisibility` isn't on the rune-transactions payload, so we
 * source it from the aggregated balances (covers held runes;
 * fully-sent runes degrade to a raw minor-unit amount).
 */
export async function loadRuneContext(indexer: IndexerClient, address: string | null): Promise<RuneContext> {
  const context: RuneContext = { byTxid: new Map(), divByRuneId: new Map() };
  if (!address) return context;
  const [runeTxRes, runeBalRes] = await Promise.allSettled([
    indexer.getBtcAddressRuneTransactions(address, { limit: 50 }),
    indexer.getBtcAddressRunes(address),
  ]);
  if (runeTxRes.status === "fulfilled") {
    const txs = runeTxRes.value?.transactions ?? [];
    for (const [txid, ev] of indexRuneTxsByTxid(txs)) context.byTxid.set(txid, ev);
  }
  if (runeBalRes.status === "fulfilled") {
    for (const b of runeBalRes.value?.balances ?? []) {
      if (b?.rune_id && typeof b.divisibility === "number") {
        context.divByRuneId.set(b.rune_id, b.divisibility);
      }
    }
  }
  return context;
}

export interface InscriptionContext {
  byOutpoint: Map<string, BtcInscriptionSummary>;
  byLandingTxid: Map<string, BtcInscriptionSummary>;
}

/**
 * Inscription transfer labels. Best-effort, like the rune join:
 * there's no inscription-history endpoint, so we use the address's
 * current inscriptions (satpoint = "txid:vout:offset") to recognize
 * (a) a tx that SPENDS an inscription UTXO -> outbound send, and
 * (b) a tx whose output now HOLDS the inscription -> inbound receive.
 * A pending send still shows the inscription at its old (input-side)
 * satpoint, so (a) catches it; once confirmed under the recipient,
 * (b) catches their receive. A fully-sent, already-reindexed
 * inscription drops off the sender's list -> that historical row
 * degrades to a plain BTC label (same limitation as fully-sent runes).
 */
export async function loadInscriptionContext(
  indexer: IndexerClient,
  address: string | null,
): Promise<InscriptionContext> {
  const context: InscriptionContext = { byOutpoint: new Map(), byLandingTxid: new Map() };
  if (!address) return context;
  try {
    const insRes = await indexer.getBtcAddressInscriptions(address);
    for (const ins of insRes?.inscriptions ?? []) {
      const sp = ins?.satpoint;
      if (typeof sp !== "string") continue;
      const [stxid, svout] = sp.split(":");
      if (stxid && svout != null && svout !== "") {
        context.byOutpoint.set(`${stxid}:${svout}`, ins);
        context.byLandingTxid.set(stxid, ins);
      }
    }
  } catch {
    // Inscription labels are non-essential; never block BTC history.
  }
  return context;
}

/** Activity rows for one Bitcoin address. Throws when the address listing can't be read. */
export async function loadBtcHistory(
  indexer: IndexerClient,
  btcAddr: string,
  runes: RuneContext,
  inscriptions: InscriptionContext,
  btcExplorer: string,
): Promise<TxItem[]> {
  const items: TxItem[] = [];
  const btcTxs = await indexer.getBtcAddressTxs(btcAddr);
  const rawList = btcTxs ?? [];
  if (rawList.length === 0) {
    console.info("[History] No BTC transactions for", btcAddr);
  }

  const fullTxs = await Promise.all(
    rawList.map(async (entry) => {
      // The address-level listing returns either a bare txid
      // string OR a minimal `{txid, status?}` object for
      // mempool entries (no `vin`/`vout`/`input`/`output`).
      // The minimal shape causes `parseBtcTx` to bail out to
      // direction=unknown and produce the unhelpful "BTC
      // Transaction" row with no amount. Re-fetch whenever
      // the entry doesn't already carry input/output arrays.
      if (typeof entry === "object" && entry !== null && (entry as any).txid) {
        const obj = entry as any;
        const hasIO =
          Array.isArray(obj.vin) ||
          Array.isArray(obj.vout) ||
          Array.isArray(obj.input) ||
          Array.isArray(obj.output);
        if (hasIO) return obj;
        try {
          return await indexer.getBtcTransaction(obj.txid);
        } catch {
          return obj;
        }
      }
      const txid = typeof entry === "string" ? entry : null;
      if (!txid) return null;
      try {
        return await indexer.getBtcTransaction(txid);
      } catch {
        return { txid };
      }
    })
  );

  for (const tx of fullTxs) {
    if (!tx) continue;
    const txid = (tx as any).txid;
    if (!txid) continue;

    const { direction, amountSats } = (tx as any).input || (tx as any).vin
      ? parseBtcTx(tx, btcAddr)
      : { direction: "unknown" as const, amountSats: 0 };

    const statusObj = (tx as any).status;
    const isConfirmed =
      typeof statusObj === "object" && statusObj !== null
        ? Boolean(statusObj.confirmed)
        : false;
    const rawTimeMs = await resolveBtcTxTimestampMs(indexer, tx as Record<string, unknown>);
    // Clamp display timestamps to <= now. The indexer
    // occasionally returns a mempool/block timestamp that's
    // ahead of the user's local clock (Bitcoin block-time
    // anti-malleability slack tolerates up to +2h, and some
    // mempool views surface the next-block projection); a
    // "12:26 PM" stamp on a tx that broadcast at 11:44 AM is
    // confusing and looks broken. Never display a future
    // moment for a transaction that has actually happened.
    const nowMs = Date.now();
    const timeMs = rawTimeMs != null && rawTimeMs > nowMs ? nowMs : rawTimeMs;

    // Rune transfers are BTC txs with an OP_RETURN OP_13
    // runestone output. Prefer the authoritative rune-transactions
    // join (real rune name + signed amount + direction); fall back
    // to the local runestone sniff for mempool transfers the rune
    // index hasn't picked up yet.
    const runeEvent = runes.byTxid.get(txid);
    const isRune = Boolean(runeEvent) || txHasRunestone(tx);

    // Inscription send/receive: a spent input that is a known
    // inscription UTXO => outbound; otherwise an inscription that
    // landed in THIS tx (satpoint txid === txid) => inbound. Runes
    // win if both somehow match (disjoint in practice).
    let inscriptionHit: { ins: BtcInscriptionSummary; dir: "out" | "in" } | null = null;
    if (!isRune) {
      for (const op of inputOutpoints(tx)) {
        const ins = inscriptions.byOutpoint.get(op);
        if (ins) {
          inscriptionHit = { ins, dir: "out" };
          break;
        }
      }
      if (!inscriptionHit) {
        const landed = inscriptions.byLandingTxid.get(txid);
        if (landed) inscriptionHit = { ins: landed, dir: "in" };
      }
    }

    let rowLabel: string;
    let rowDirection: TxItem["direction"] = direction;
    let rowAmountLabel: string | undefined;

    if (runeEvent) {
      rowLabel = runeRowLabel(runeEvent);
      const amt = formatRuneDelta(runeEvent.delta, runes.divByRuneId.get(runeEvent.rune_id));
      if (amt) {
        rowDirection = amt.direction;
        rowAmountLabel = amt.amountLabel;
      }
    } else if (inscriptionHit) {
      // Label without a BTC amount: the only sats that move are the
      // inscription's dust postage + fee, which would misrepresent
      // the transfer as a tiny BTC payment.
      const num = inscriptionHit.ins.number;
      const suffix = typeof num === "number" ? ` #${num}` : "";
      rowLabel =
        inscriptionHit.dir === "out"
          ? `Sent Inscription${suffix}`
          : `Received Inscription${suffix}`;
      rowDirection = inscriptionHit.dir;
    } else if (isRune) {
      // Runestone detected locally but not yet in the rune index.
      // Label without an amount -- the BTC dust+fee debit (~1500-
      // 2500 sats) would misrepresent a rune move as a BTC amount.
      rowLabel =
        direction === "in" ? "Received Rune"
        : direction === "out" ? "Sent Rune"
        : "Rune Transfer";
    } else {
      rowLabel =
        direction === "in" ? "Received BTC"
        : direction === "out" ? "Sent BTC"
        : direction === "self" ? "BTC Consolidation"
        : "BTC Transaction";
      if (amountSats > 0) {
        const sign = direction === "out" ? "-" : direction === "in" ? "+" : "";
        rowAmountLabel = `${sign}${formatBtc(amountSats)}`;
      }
    }

    // Only attach raw sats (drives the USD subtitle) for genuine
    // BTC rows; rune/inscription rows aren't a BTC value movement.
    const showBtcAmount = !isRune && !inscriptionHit && amountSats > 0;
    items.push({
      txid,
      displayTxid: truncateAddress(txid, 8),
      type: "btc",
      direction: rowDirection,
      label: rowLabel,
      amountLabel: rowAmountLabel,
      amountSats: showBtcAmount ? amountSats : undefined,
      sats: showBtcAmount ? amountSats : undefined,
      timestamp: timeMs != null ? String(timeMs) : "",
      status: isConfirmed ? "confirmed" : "pending",
      explorerUrl: `${btcExplorer}${txid}`,
    });
  }
  return items;
}
