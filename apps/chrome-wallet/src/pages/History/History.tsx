import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../hooks/useWallet";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import {
  getIndexer,
  isIndexerAuthError,
  isIndexerNotFoundError,
  isIndexerRateLimitError,
} from "../../utils/indexer";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { formatArchId, truncateAddress, formatBtc, timestampToMs } from "../../utils/format";
import { resolveBtcTxTimestampMs } from "../../utils/btc-timestamps";
import { txHasRunestone } from "../../utils/btc-tx-classify";
import { indexRuneTxsByTxid, runeRowLabel, formatRuneDelta } from "../../utils/rune-history";
import type { BtcRuneTransaction } from "../../utils/indexer";
import { summarizeArchTx } from "../../utils/arch-tx-summary";
import { normalizeArchStatus } from "../../utils/tx-status";
import ArchIcon from "../../components/ArchIcon";
import { ActivityRow, type ActivityRowTx } from "../../components/ActivityRow";

type Tab = "all" | "arch" | "btc";
type TxKind = ActivityRowTx["type"];

interface TxItem extends ActivityRowTx {
  /** Raw sats for BTC, kept for future USD conversion / filters. */
  amountSats?: number;
}

function parseBtcTx(tx: any, walletAddress: string): { direction: "in" | "out" | "self" | "unknown"; amountSats: number } {
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

function isAplTransaction(tx: any): boolean {
  if (Array.isArray(tx.token_mints) && tx.token_mints.length > 0) return true;
  if (tx.token_transfer) return true;
  return false;
}

type FetchBanner =
  | { kind: "none" }
  | { kind: "rate-limit"; chain: "btc" | "arch" }
  | { kind: "auth"; chain: "btc" | "arch" }
  | { kind: "other"; chain: "btc" | "arch"; message: string };

export default function History() {
  const { activeAccount, state } = useWallet();
  const { price: btcUsd } = useBtcUsdPrice();
  const [tab, setTab] = useState<Tab>("all");
  const [transactions, setTransactions] = useState<TxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [archPage, setArchPage] = useState(1);
  const [hasMoreArch, setHasMoreArch] = useState(false);
  // Captured indexer error so we can render an inline banner rather
  // than the misleading "No transactions yet" empty state when the
  // fetch actually failed. We prefer BTC errors when both chains
  // error in the same fetch, because the empty BTC list is the
  // user-visible outcome and worth explaining.
  const [banner, setBanner] = useState<FetchBanner>({ kind: "none" });

  const isTestnet = state.network === "testnet4";
  const archExplorer = isTestnet ? "https://explorer.arch.network/testnet/tx/" : "https://explorer.arch.network/mainnet/tx/";
  const btcExplorer = isTestnet ? "https://mempool.space/testnet4/tx/" : "https://mempool.space/tx/";

  const fetchTransactions = useCallback(async () => {
    if (!activeAccount) return;
    setLoading(true);
    setBanner({ kind: "none" });
    try {
      const indexer = await getIndexer();
      const items: TxItem[] = [];
      // Track per-chain errors so we can decide on a single banner
      // at the end. We don't bail on the first failure: an Arch
      // outage shouldn't hide the user's BTC history, and vice
      // versa.
      let archError: unknown = null;
      let btcError: unknown = null;
      // archAddress may be empty for legacy accounts -- derive from pubkey
      // if needed. Falling back to btcAddress would just query a nonexistent
      // Arch account and silently return empty.
      const archAddr = activeAccount.archAddress
        || (activeAccount.publicKeyHex ? deriveArchAccountAddress(activeAccount.publicKeyHex) : "");
      const btcAddr = reEncodeTaprootAddress(activeAccount.btcAddress, state.network);

      if (!archAddr) {
        console.warn("[History] No arch address resolved for active account; skipping Arch tx fetch.");
      }

      const tokenTxIds = new Set<string>();
      // We also keep the user's ATA addresses so the per-tx classifier
      // can recognize CPI'd token movements into / out of them. The
      // tree endpoint emits source/destination as ATA addresses (not
      // the user's archAddress), so without this set we'd miss the
      // incoming leg of a swap entirely.
      const tokenAccounts: string[] = [];
      try {
        const tokensRes = await indexer.getAccountTokens(archAddr);
        for (const t of tokensRes?.tokens ?? []) {
          const acct = t.token_account_address as string | undefined;
          if (acct) tokenAccounts.push(acct);
        }

        const tokenTxResults = await Promise.allSettled(
          tokenAccounts.map((acct) => indexer.getAccountTransactions(acct, 50))
        );
        for (const r of tokenTxResults) {
          if (r.status === "fulfilled") {
            for (const tx of (r.value?.transactions ?? [])) {
              const txid = (tx as any)?.txid;
              if (txid) tokenTxIds.add(String(txid));
            }
          }
        }
      } catch {
        // token enrichment is best-effort
      }

      if (archAddr) {
      try {
        // v2 ships chip labels + decoded token_transfer summaries inline so we
        // can derive direction/amount/label without per-tx /instructions calls.
        const archRes = await indexer
          .getAccountTransactionsV2(archAddr, 20, archPage)
          .catch((err) => {
            console.warn("[History] v2 transactions failed, falling back to v1:", err?.message);
            return indexer.getAccountTransactions(archAddr, 20, archPage);
          });
        const archTxs = archRes?.transactions ?? [];
        if (archTxs.length === 0 && archPage === 1) {
          console.info("[History] No Arch transactions for", archAddr);
        }
        setHasMoreArch(archTxs.length >= 20);

        // Fetch detail + tree per tx in parallel. The tree gives us
        // the full CPI hierarchy (children array) — without it, swaps
        // and other custom-instruction transactions can't be classified
        // as APL token movements and would fall back to the generic
        // "Custom Instruction" label.
        const detailedArchTxs = await Promise.all(
          (archTxs as any[]).map(async (tx) => {
            const [detail, tree] = await Promise.all([
              indexer.getTransactionDetail(tx.txid).catch(() => null),
              indexer.getTransactionTree(tx.txid).catch(() => null),
            ]);
            return {
              merged: { ...tx, ...(detail ?? {}) },
              tree,
            };
          })
        );

        for (const { merged: tx, tree } of detailedArchTxs) {
          const isToken = isAplTransaction(tx) || tokenTxIds.has(tx.txid);
          const kind: TxKind = isToken ? "apl" : "arch";
          const status = normalizeArchStatus(tx);
          // Pass the normalized status through so the summarizer's failure
          // detection catches it without re-running the same logic.
          const summary = summarizeArchTx(
            { ...tx, status },
            archAddr,
            { tree, tokenAccounts },
          );
          items.push({
            txid: tx.txid,
            displayTxid: truncateAddress(formatArchId(tx.txid), 8),
            type: kind,
            direction:
              summary.direction === "in" ? "in"
              : summary.direction === "out" ? "out"
              : summary.direction === "neutral" ? "neutral"
              : "unknown",
            label: summary.label,
            amountLabel: summary.amountLabel,
            timestamp: tx.created_at || "",
            status,
            explorerUrl: `${archExplorer}${tx.txid}`,
          });
        }
      } catch (e: any) {
        archError = e;
        console.warn("[History] Arch transaction fetch failed:", e?.message);
      }
      }

      // Rune transfer history for accurate row labels + amounts. Both
      // calls are best-effort: a failure must not hide BTC history, so
      // rune rows fall back to the local runestone heuristic below.
      // `divisibility` isn't on the rune-transactions payload, so we
      // source it from the aggregated balances (covers held runes;
      // fully-sent runes degrade to a raw minor-unit amount).
      const runeTxByTxid = new Map<string, BtcRuneTransaction>();
      const runeDivByRuneId = new Map<string, number>();
      {
        const [runeTxRes, runeBalRes] = await Promise.allSettled([
          indexer.getBtcAddressRuneTransactions(btcAddr, { limit: 50 }),
          indexer.getBtcAddressRunes(btcAddr),
        ]);
        if (runeTxRes.status === "fulfilled") {
          const txs = runeTxRes.value?.transactions ?? [];
          for (const [txid, ev] of indexRuneTxsByTxid(txs)) runeTxByTxid.set(txid, ev);
        }
        if (runeBalRes.status === "fulfilled") {
          for (const b of runeBalRes.value?.balances ?? []) {
            if (b?.rune_id && typeof b.divisibility === "number") {
              runeDivByRuneId.set(b.rune_id, b.divisibility);
            }
          }
        }
      }

      try {
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
          const runeEvent = runeTxByTxid.get(txid);
          const isRune = Boolean(runeEvent) || txHasRunestone(tx);

          let rowLabel: string;
          let rowDirection: TxItem["direction"] = direction;
          let rowAmountLabel: string | undefined;

          if (runeEvent) {
            rowLabel = runeRowLabel(runeEvent);
            const amt = formatRuneDelta(runeEvent.delta, runeDivByRuneId.get(runeEvent.rune_id));
            if (amt) {
              rowDirection = amt.direction;
              rowAmountLabel = amt.amountLabel;
            }
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
          // BTC rows; rune rows carry a rune amount, not a BTC value.
          const showBtcAmount = !isRune && amountSats > 0;
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
      } catch (e: any) {
        btcError = e;
        console.warn("[History] BTC transaction fetch failed:", e?.message);
      }

      // Pick one banner. BTC errors win on tie because the empty
      // BTC list is what the user came here to see (and we already
      // know from the bug report that silent BTC failures are the
      // worst UX). 404 from the indexer is "no history yet", which
      // is not an error -- skip it.
      const decideBanner = (
        err: unknown,
        chain: "btc" | "arch",
      ): FetchBanner | null => {
        if (!err) return null;
        if (isIndexerNotFoundError(err)) return null;
        if (isIndexerRateLimitError(err)) {
          return { kind: "rate-limit", chain };
        }
        if (isIndexerAuthError(err)) {
          return { kind: "auth", chain };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "other", chain, message };
      };
      const nextBanner =
        decideBanner(btcError, "btc") ?? decideBanner(archError, "arch");
      if (nextBanner) setBanner(nextBanner);

      items.sort((a, b) => {
        const aPending = a.status === "pending" || a.status === "unconfirmed";
        const bPending = b.status === "pending" || b.status === "unconfirmed";
        if (aPending && !bPending) return -1;
        if (!aPending && bPending) return 1;
        const ta = timestampToMs(a.timestamp) ?? 0;
        const tb = timestampToMs(b.timestamp) ?? 0;
        return tb - ta;
      });

      setTransactions(items);
    } catch (e: any) {
      // Failure here means getIndexer / outer setup threw -- typically
      // a missing API key. Surface as an auth banner so the user knows
      // where to look.
      console.warn("[History] indexer client init failed:", e?.message);
      setBanner({
        kind: isIndexerAuthError(e) ? "auth" : "other",
        chain: "btc",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [activeAccount, archPage, archExplorer, btcExplorer, state.network]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  const filtered =
    tab === "all" ? transactions
    : tab === "arch" ? transactions.filter((tx) => tx.type === "arch" || tx.type === "apl")
    : transactions.filter((tx) => tx.type === "btc");

  return (
    <>
      <div className="tabs">
        <button className={`tab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>
          All
        </button>
        <button className={`tab ${tab === "arch" ? "active" : ""}`} onClick={() => setTab("arch")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <ArchIcon size={12} color={tab === "arch" ? "#c19a5b" : "#888"} /> Arch
          </span>
        </button>
        <button className={`tab ${tab === "btc" ? "active" : ""}`} onClick={() => setTab("btc")}>
          ₿ Bitcoin
        </button>
      </div>

      {banner.kind !== "none" && (
        <div
          className="card"
          style={{
            marginBottom: 10,
            padding: 10,
            background: "rgba(255,176,32,0.10)",
            border: "1px solid rgba(255,176,32,0.30)",
            fontSize: 12,
          }}
        >
          {banner.kind === "rate-limit" ? (
            <>
              <strong>
                {banner.chain === "btc" ? "Bitcoin" : "Arch"} indexer rate-limited.
              </strong>{" "}
              Your API key is sharing quota with too many callers. Update it in{" "}
              <em>Settings → Show advanced settings → Indexer API</em> and try
              again.
            </>
          ) : banner.kind === "auth" ? (
            <>
              <strong>Indexer rejected the API key.</strong> Set a valid key in{" "}
              <em>Settings → Show advanced settings → Indexer API</em>.
            </>
          ) : (
            <>
              <strong>
                Couldn&apos;t load {banner.chain === "btc" ? "Bitcoin" : "Arch"}{" "}
                history.
              </strong>{" "}
              {banner.message}
            </>
          )}
        </div>
      )}
      {loading ? (
        <div className="spinner-center">
          <div className="spinner" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📭</div>
          <div>
            {banner.kind === "none" ? "No transactions yet" : "Nothing to show"}
          </div>
        </div>
      ) : (
        <div className="card">
          {filtered.map((tx) => (
            <ActivityRow
              key={`${tx.type}-${tx.txid}`}
              tx={tx}
              variant="activity"
              btcUsd={btcUsd}
            />
          ))}
        </div>
      )}

      {hasMoreArch && tab !== "btc" && (
        <button
          className="btn btn-secondary btn-full"
          style={{ marginTop: 12 }}
          onClick={() => setArchPage((p) => p + 1)}
        >
          Load more
        </button>
      )}
    </>
  );
}

