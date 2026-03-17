import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { WalletOverviewResponse } from "@arch/wallet-hub-sdk";
import type { ConnectedWallet } from "../../types";
import AddressDisplay from "../shared/AddressDisplay";
import TokenList from "./TokenList";
import { formatArchId } from "../../utils/archFormat";

type RawTx = {
  txid?: string;
  tx_id?: string;
  id?: string;
  slot?: number;
  height?: number;
  block_height?: number;
  success?: boolean;
  fee?: string;
  status?: Record<string, unknown>;
  created_at?: string;
  instructions?: string[];
  [key: string]: unknown;
};

type DashboardViewProps = {
  client: WalletHubClient;
  wallet: ConnectedWallet;
  externalUserId: string;
};

function formatBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

function getTxid(tx: RawTx): string {
  return tx.txid || tx.tx_id || tx.id || "";
}

function truncateTxid(s: string): string {
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-8)}`;
}

function txStatusLabel(tx: RawTx): string {
  const s = tx.status;
  if (s && typeof s === "object") {
    const sType = String((s as Record<string, unknown>).type ?? "").toLowerCase();
    if (sType === "failed") return "Failed";
    if (sType === "processed" || sType === "success") return "Success";
  }
  if (tx.success === true || (tx.success as any) === "true") return "Success";
  if (tx.success === false || (tx.success as any) === "false") return "Failed";
  if (tx.height !== undefined || tx.block_height !== undefined) return "Confirmed";
  return "Pending";
}

function BalanceSkeleton() {
  return <span className="balance-skeleton" />;
}

export default function DashboardView({
  client,
  wallet,
  externalUserId,
}: DashboardViewProps) {
  const [overview, setOverview] = useState<WalletOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [airdropLoading, setAirdropLoading] = useState(false);

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.getWalletOverview(wallet.address);
      setOverview(data);
    } catch (e: any) {
      setError(e?.message || "Failed to load wallet overview");
    } finally {
      setLoading(false);
    }
  }, [client, wallet.address]);

  useEffect(() => {
    fetchOverview();
  }, [fetchOverview]);

  const handleAirdrop = useCallback(async () => {
    const resolvedArch = overview?.archAccountAddress || wallet.archAddress;
    if (!resolvedArch) {
      setError("Arch address not resolved yet — wait for the dashboard to load.");
      return;
    }
    setAirdropLoading(true);
    setError(null);
    try {
      const prevLamports = (overview?.arch?.account as any)?.lamports_balance ?? -1;
      await client.requestFaucetAirdrop(resolvedArch);

      const DELAYS = [2000, 3000, 4000, 5000, 6000];
      for (const delay of DELAYS) {
        await new Promise((r) => setTimeout(r, delay));
        try {
          const fresh = await client.getWalletOverview(wallet.address);
          setOverview(fresh);
          const newLamports = (fresh?.arch?.account as any)?.lamports_balance ?? -1;
          if (newLamports !== prevLamports) break;
        } catch {
          // ignore transient fetch errors during polling
        }
      }
    } catch (e: any) {
      setError(e?.message || "Airdrop failed");
    } finally {
      setAirdropLoading(false);
      setLoading(false);
    }
  }, [client, overview, wallet.address, wallet.archAddress]);

  const btcSummary = overview?.btc?.summary;
  const chainFunded = btcSummary?.chain_stats?.funded_txo_sum ?? 0;
  const chainSpent = btcSummary?.chain_stats?.spent_txo_sum ?? 0;
  const mempoolFunded = btcSummary?.mempool_stats?.funded_txo_sum ?? 0;
  const mempoolSpent = btcSummary?.mempool_stats?.spent_txo_sum ?? 0;
  const totalBtcSats =
    chainFunded - chainSpent + (mempoolFunded - mempoolSpent);

  const archAccount = overview?.arch?.account as Record<string, unknown> | null | undefined;
  const archLamports = archAccount?.lamports_balance as number | undefined;
  const archBalance = typeof archLamports === "number" ? archLamports / 1_000_000_000 : null;
  const archAddress = overview?.archAccountAddress || wallet.archAddress || "";
  const recentTxs: RawTx[] =
    (overview?.arch?.recentTransactions as any)?.transactions?.slice(0, 5) ?? [];

  return (
    <div className="dashboard-view">
      {error && (
        <div className="dashboard-banner-error">
          <span>{error}</span>
          <button onClick={() => setError(null)} type="button">
            ✕
          </button>
        </div>
      )}

      <div className="wallet-identity">
        <h2 className="wallet-identity-title">Wallet</h2>
        <div className="wallet-identity-addresses">
          <AddressDisplay address={wallet.address} label="BTC" full />
          {archAddress && (
            <AddressDisplay address={archAddress} label="ARCH" full />
          )}
        </div>
      </div>

      <div className="balance-cards">
        <div className="balance-card">
          <span className="balance-asset">BTC</span>
          <span className="balance-amount">
            {loading ? <BalanceSkeleton /> : formatBtc(totalBtcSats)}
          </span>
          <span className="balance-sub">
            {loading ? "" : `${totalBtcSats.toLocaleString()} sats`}
          </span>
          <Link to="/send" className="balance-action btn-secondary">
            Send
          </Link>
        </div>

        <div className="balance-card">
          <span className="balance-asset">ARCH</span>
          <span className="balance-amount">
            {loading ? <BalanceSkeleton /> : archBalance !== null ? archBalance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 }) : "—"}
          </span>
          <span className="balance-sub">
            {!loading && typeof archLamports === "number" ? `${archLamports.toLocaleString()} lamports` : ""}
          </span>
          <Link to="/send" className="balance-action btn-secondary">
            Send
          </Link>
        </div>
      </div>

      <TokenList client={client} address={wallet.address} />

      <div className="quick-actions">
        <Link to="/send" className="btn-primary quick-action-btn">
          Send
        </Link>
        <Link to="/receive" className="btn-secondary quick-action-btn">
          Receive
        </Link>
        <button
          className="btn-secondary quick-action-btn"
          onClick={handleAirdrop}
          disabled={airdropLoading}
          type="button"
        >
          {airdropLoading ? (
            <>
              <span className="spinner small" />
              Airdrop…
            </>
          ) : (
            "Airdrop"
          )}
        </button>
      </div>

      <div className="recent-transactions">
        <h3 className="recent-transactions-title">Recent Transactions</h3>
        {loading ? (
          <div className="tx-list-skeleton">
            <div className="tx-skeleton-row" />
            <div className="tx-skeleton-row" />
            <div className="tx-skeleton-row" />
          </div>
        ) : recentTxs.length === 0 ? (
          <p className="recent-transactions-empty">No transactions yet.</p>
        ) : (
          <div className="tx-list">
            {recentTxs.map((tx, i) => {
              const txid = getTxid(tx);
              const displayTxid = formatArchId(txid);
              const height = tx.height ?? tx.block_height ?? tx.slot;
              return (
                <div key={txid || i} className="tx-row">
                  <span className="tx-id mono">{truncateTxid(displayTxid)}</span>
                  <span className="tx-status">{txStatusLabel(tx)}</span>
                  <span className="tx-type">
                    {height !== undefined ? `Block ${height}` : "—"}
                  </span>
                  <span className="tx-time">
                    {tx.fee ? `Fee: ${tx.fee}` : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
