import EmptyStateArt from "../../components/EmptyStateArt";
import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../hooks/useWallet";
import { useBtcUsdPrice } from "../../hooks/useBtcUsdPrice";
import { useRetryCountdown } from "../../hooks/useRetryCountdown";
import { USE_DIRECT_INDEXER } from "../../utils/explorer-config";
import { hubRetryAfterMs } from "../../utils/hub-rate-limit";
import {
  getIndexer,
  isIndexerAuthError,
  isIndexerNotFoundError,
  isIndexerRateLimitError,
} from "../../utils/indexer";
import { resolveAccountAddresses } from "../../state/account-addresses";
import { deriveArchAccountAddress } from "../../utils/sdk";
import { formatArchId, truncateAddress, timestampToMs } from "../../utils/format";
import { summarizeArchTx } from "../../utils/arch-tx-summary";
import { normalizeArchStatus } from "../../utils/tx-status";
import ArchIcon from "../../components/ArchIcon";
import { ActivityRow, type ActivityRowTx } from "../../components/ActivityRow";
import { loadBtcHistory, loadInscriptionContext, loadRuneContext, type TxItem } from "./btc-history";

type Tab = "all" | "arch" | "btc";
type TxKind = ActivityRowTx["type"];

function isAplTransaction(tx: any): boolean {
  if (Array.isArray(tx.token_mints) && tx.token_mints.length > 0) return true;
  if (tx.token_transfer) return true;
  return false;
}

/** Retry delay for a rate limit that carries none, e.g. an upstream indexer throttle. */
const RATE_LIMIT_RETRY_FALLBACK_MS = 30_000;

type FetchBanner =
  | { kind: "none" }
  | { kind: "rate-limit"; chain: "btc" | "arch"; retryAt: number }
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
  const archExplorer = isTestnet ? "https://explorer.arch.network/testnet/tx/" : "https://explorer.arch.network/tx/";
  const btcExplorer = isTestnet ? "https://mempool.space/testnet4/tx/" : "https://mempool.space/tx/";
  // A relink can add addresses without changing any other account field.
  const btcAddressKey = activeAccount
    ? resolveAccountAddresses(activeAccount, state.network).all.join(",")
    : "";

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
      const btcAddresses = resolveAccountAddresses(activeAccount, state.network);

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
      // Inbound APL transfers are recorded against the destination token
      // account (ATA); the recipient's archAddress is not a participant, so
      // those transfers never appear in the archAddr feed above. Keep the
      // raw per-ATA transactions (deduped by txid) so we can merge them in as
      // their own rows below, mirroring TokenDetail's ATA-based history.
      const ataTxById = new Map<string, any>();
      try {
        const tokensRes = await indexer.getAccountTokens(archAddr);
        for (const t of tokensRes?.tokens ?? []) {
          const acct = t.token_account_address as string | undefined;
          if (acct) tokenAccounts.push(acct);
        }

        // Prefer v2 (inline chip labels + token_transfer summaries) with the
        // same fallback-to-v1 pattern used for archAddr.
        const tokenTxResults = await Promise.allSettled(
          tokenAccounts.map((acct) =>
            indexer
              .getAccountTransactionsV2(acct, 50)
              .catch((err) => {
                if (isIndexerRateLimitError(err)) throw err;
                return indexer.getAccountTransactions(acct, 50);
              })
          )
        );
        for (const r of tokenTxResults) {
          if (r.status === "fulfilled") {
            for (const tx of (r.value?.transactions ?? [])) {
              const txid = (tx as any)?.txid;
              if (!txid) continue;
              tokenTxIds.add(String(txid));
              if (!ataTxById.has(String(txid))) ataTxById.set(String(txid), tx);
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
            if (isIndexerRateLimitError(err)) throw err;
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

      // Merge ATA-only transactions as their own rows. Inbound APL transfers
      // land on the destination token account (where the recipient's
      // archAddress is not a participant), so the archAddr feed above never
      // includes them. Skip any txid already added from the archAddr feed (a
      // tx touching both legs must appear once), then classify each remaining
      // ATA tx with the same detail+tree summarizer path used above. These
      // are fetched as a flat recent window (not paged with archPage), so
      // received tokens always surface regardless of the archAddr page.
      if (archAddr && ataTxById.size > 0) {
        const seenTxIds = new Set(items.map((i) => i.txid));
        const ataOnly = [...ataTxById.values()].filter(
          (tx) => tx?.txid && !seenTxIds.has(String(tx.txid))
        );
        try {
          const detailedAtaTxs = await Promise.all(
            ataOnly.map(async (tx) => {
              const [detail, tree] = await Promise.all([
                indexer.getTransactionDetail(tx.txid).catch(() => null),
                indexer.getTransactionTree(tx.txid).catch(() => null),
              ]);
              return { merged: { ...tx, ...(detail ?? {}) }, tree };
            })
          );
          for (const { merged: tx, tree } of detailedAtaTxs) {
            const status = normalizeArchStatus(tx);
            const summary = summarizeArchTx(
              { ...tx, status },
              archAddr,
              { tree, tokenAccounts },
            );
            items.push({
              txid: tx.txid,
              displayTxid: truncateAddress(formatArchId(tx.txid), 8),
              type: "apl",
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
          console.warn("[History] ATA transaction merge failed:", e?.message);
        }
      }

      // Runes live at the ordinals address; a transfer between the
      // account's own addresses appears under both, so keep the first.
      const [runes, inscriptions] = await Promise.all([
        loadRuneContext(indexer, btcAddresses.ordinals),
        loadInscriptionContext(indexer, btcAddresses.ordinals),
      ]);
      const seenBtcTxids = new Set<string>();
      for (const address of btcAddresses.all) {
        try {
          for (const item of await loadBtcHistory(indexer, address, runes, inscriptions, btcExplorer)) {
            if (seenBtcTxids.has(item.txid)) continue;
            seenBtcTxids.add(item.txid);
            items.push(item);
          }
        } catch (e: any) {
          btcError ??= e;
          console.warn("[History] BTC transaction fetch failed:", e?.message);
        }
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
          const retryAfterMs = hubRetryAfterMs(err) ?? RATE_LIMIT_RETRY_FALLBACK_MS;
          return { kind: "rate-limit", chain, retryAt: Date.now() + retryAfterMs };
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
  }, [
    activeAccount?.id,
    activeAccount?.archAddress,
    activeAccount?.publicKeyHex,
    activeAccount?.btcAddress,
    btcAddressKey,
    archPage,
    archExplorer,
    btcExplorer,
    state.network,
  ]);

  useEffect(() => {
    fetchTransactions();
  }, [fetchTransactions]);

  // Direct-indexer builds spend the user's own key, so their banner
  // points at Settings instead of waiting the limit out.
  const busySeconds = useRetryCountdown(
    banner.kind === "rate-limit" && !USE_DIRECT_INDEXER ? banner.retryAt : null,
    () => void fetchTransactions(),
  );

  const filtered =
    tab === "all" ? transactions
    : tab === "arch" ? transactions.filter((tx) => tx.type === "arch" || tx.type === "apl")
    : transactions.filter((tx) => tx.type === "btc");
  const tabFailed = banner.kind !== "none" && (tab === "all" || tab === banner.chain);

  return (
    <>
      <div className="tabs">
        <button className={`tab ${tab === "all" ? "active" : ""}`} onClick={() => setTab("all")}>
          All
        </button>
        <button className={`tab ${tab === "arch" ? "active" : ""}`} onClick={() => setTab("arch")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <ArchIcon size={12} color={tab === "arch" ? "var(--color-primary)" : "var(--text-muted)"} /> Arch
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
            overflowWrap: "anywhere",
          }}
        >
          {banner.kind === "rate-limit" && busySeconds !== null ? (
            <>
              <strong>Busy right now.</strong>{" "}
              {busySeconds > 0 ? `Retrying in ${busySeconds}s…` : "Retrying…"}
            </>
          ) : banner.kind === "rate-limit" ? (
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
              The indexer didn&apos;t respond. Anything shown may be incomplete.
            </>
          )}
          <div>
            <button className="link-btn" onClick={() => void fetchTransactions()} disabled={loading}>
              {loading ? "Retrying…" : "Retry"}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="spinner-center">
          <div className="spinner" />
        </div>
      ) : filtered.length === 0 ? (
        // A failed load is not an empty history: the banner above says so.
        tabFailed ? null : (
          <div className="empty-state">
            <EmptyStateArt kind="activity" />
            <div>No transactions yet</div>
          </div>
        )
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
