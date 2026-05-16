import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { getIndexer } from "../../utils/indexer";
import { formatTokenAmount, formatArchId, truncateAddress, formatTimestamp, hexToBase58 } from "../../utils/format";
import { enrichTokenFromRpc } from "../../utils/arch-rpc";
import { deriveArchAccountAddress } from "../../utils/sdk";
import {
  type TxStatus,
  normalizeArchStatus,
  statusBadgeClass,
  statusLabel,
} from "../../utils/tx-status";
import CopyButton from "../../components/CopyButton";
import ArchIcon from "../../components/ArchIcon";

interface TokenDetailData {
  mint: string;
  symbol: string;
  name: string;
  balance: number;
  decimals: number;
  uiAmount: string;
  image?: string;
  tokenAccount: string;
}

interface TxItem {
  txid: string;
  displayTxid: string;
  timestamp: string;
  status: TxStatus;
  explorerUrl: string;
  direction: "in" | "out" | "neutral";
  amountLabel: string | null;
}

const TRANSFER_INSTRUCTION_LABELS = new Set([
  "Transfer",
  "TransferChecked",
  "MintTo",
  "MintToChecked",
  "Burn",
  "BurnChecked",
]);

// Labels we know are purely account/admin operations -- not balance movements.
const NON_TRANSFER_LABELS = new Set([
  "CreateAssociatedTokenAccount",
  "InitializeAccount",
  "InitializeAccount2",
  "InitializeAccount3",
  "InitializeMint",
  "InitializeMint2",
  "CloseAccount",
  "Approve",
  "ApproveChecked",
  "Revoke",
  "SetAuthority",
  "FreezeAccount",
  "ThawAccount",
  "SyncNative",
]);

// SPL/APL token program transfer-y discriminants (first byte of instruction data).
// 3 Transfer, 7 MintTo, 8 Burn, 12 TransferChecked, 14 MintToChecked, 15 BurnChecked.
const TRANSFER_DATA_DISCRIMINANTS = new Set([3, 7, 8, 12, 14, 15]);

const APL_TOKEN_PROGRAM_ID_HEX =
  "06ddf6e1b9ea84412c10b8df021c100fc8871907c309c33535de209c341763bf";
const APL_TOKEN_PROGRAM_ID_BASE58 = hexToBase58(APL_TOKEN_PROGRAM_ID_HEX);

function matchesAplTokenProgram(programId: unknown): boolean {
  if (typeof programId !== "string") return false;
  const lower = programId.toLowerCase().replace(/^0x/, "");
  return lower === APL_TOKEN_PROGRAM_ID_HEX || programId === APL_TOKEN_PROGRAM_ID_BASE58;
}

function firstByteOfBase64(data: unknown): number | null {
  if (typeof data !== "string" || !data) return null;
  try {
    const decoded = atob(data);
    if (!decoded.length) return null;
    return decoded.charCodeAt(0);
  } catch {
    return null;
  }
}

// Returns: true if it IS a transfer, false if it's NOT, null if unknown.
function classifyFromChipLabels(tx: any): boolean | null {
  if (tx?.token_transfer && typeof tx.token_transfer === "object") return true;
  const labels = tx?.instructions;
  if (!Array.isArray(labels) || labels.length === 0) return null;
  let sawTransfer = false;
  let sawNonTransfer = false;
  for (const label of labels) {
    if (typeof label !== "string") continue;
    if (TRANSFER_INSTRUCTION_LABELS.has(label)) sawTransfer = true;
    else if (NON_TRANSFER_LABELS.has(label)) sawNonTransfer = true;
  }
  if (sawTransfer) return true;
  if (sawNonTransfer) return false;
  return null;
}

// Authoritative classifier using per-tx `/instructions` data. Returns true if
// any APL token instruction has a transfer-y discriminant.
function classifyFromInstructions(instructions: Array<Record<string, unknown>>): boolean {
  for (const ix of instructions) {
    if (!matchesAplTokenProgram(ix?.program_id)) continue;
    const byte = firstByteOfBase64(ix?.data);
    if (byte !== null && TRANSFER_DATA_DISCRIMINANTS.has(byte)) return true;
  }
  return false;
}

// Check whether a tx's instructions touch our specific token account. Used
// to filter txs returned by the wallet's main address down to ones for this
// mint.
function instructionsTouchAccount(
  instructions: Array<Record<string, unknown>>,
  tokenAccount: string,
  mint: string,
): boolean {
  for (const ix of instructions) {
    const accounts = ix?.accounts;
    if (!Array.isArray(accounts)) continue;
    for (const a of accounts) {
      const pubkey = typeof a === "string" ? a : (a as any)?.pubkey;
      if (typeof pubkey !== "string") continue;
      if (pubkey === tokenAccount || pubkey === mint) return true;
    }
  }
  return false;
}

function formatRawAmountWithDecimals(raw: string, decimals: number): string {
  try {
    const n = BigInt(raw);
    if (decimals <= 0) return n.toString();
    const s = n.toString().padStart(decimals + 1, "0");
    const whole = s.slice(0, -decimals);
    const frac = s.slice(-decimals).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  } catch {
    return raw;
  }
}

function deriveTransfer(
  tx: any,
  tokenAccount: string,
  tokenDecimals: number,
): { direction: "in" | "out" | "neutral"; amountLabel: string | null } {
  const tt = tx?.token_transfer;
  if (!tt || typeof tt !== "object") return { direction: "neutral", amountLabel: null };

  const src = (tt.source_account ?? "") as string;
  const dst = (tt.destination_account ?? "") as string;
  const direction: "in" | "out" | "neutral" =
    dst === tokenAccount ? "in" : src === tokenAccount ? "out" : "neutral";

  const rawAmount = (tt.amount ?? "") as string;
  const decimals = typeof tt.decimals === "number" ? tt.decimals : tokenDecimals;
  if (!rawAmount) return { direction, amountLabel: null };

  const pretty = formatRawAmountWithDecimals(String(rawAmount), decimals);
  const sign = direction === "out" ? "-" : direction === "in" ? "+" : "";
  return { direction, amountLabel: `${sign}${pretty}` };
}

function BackArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function ExplorerIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

function ReceiveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

export default function TokenDetail() {
  const navigate = useNavigate();
  const { mint } = useParams<{ mint: string }>();
  const { activeAccount, state } = useWallet();

  const [token, setToken] = useState<TokenDetailData | null>(null);
  const [transactions, setTransactions] = useState<TxItem[]>([]);
  const [loadingToken, setLoadingToken] = useState(true);
  const [loadingTxs, setLoadingTxs] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isTestnet = state.network === "testnet4";
  const explorerBase = isTestnet
    ? "https://explorer.arch.network/testnet"
    : "https://explorer.arch.network/mainnet";

  useEffect(() => {
    if (!activeAccount || !mint) return;

    let cancelled = false;
    (async () => {
      setLoadingToken(true);
      setError(null);
      try {
        const indexer = await getIndexer();
        const tokenAddr = activeAccount.archAddress || activeAccount.btcAddress;
        const res = await indexer.getAccountTokens(tokenAddr);
        const rawTokens = res?.tokens ?? [];
        const raw = rawTokens.find((t) => (t.mint_address as string) === mint);
        if (!raw) {
          if (!cancelled) {
            setError("Token not found in this wallet");
            setLoadingToken(false);
          }
          return;
        }

        const base: TokenDetailData = {
          mint: raw.mint_address as string,
          symbol: (raw.symbol as string) || truncateAddress(raw.mint_address as string, 4),
          name: (raw.name as string) || "APL Token",
          balance: Number(raw.amount) || 0,
          decimals: raw.decimals ?? 0,
          uiAmount: (raw.ui_amount as string) || formatTokenAmount(Number(raw.amount) || 0, raw.decimals ?? 0),
          image: raw.image as string | undefined,
          tokenAccount: (raw.token_account_address as string) || "",
        };

        const needsEnrich = !raw.name || !raw.symbol || (!raw.decimals && raw.decimals !== undefined);
        if (needsEnrich) {
          try {
            const rpc = await enrichTokenFromRpc(indexer, raw);
            if (rpc.name) base.name = rpc.name;
            if (rpc.symbol) base.symbol = rpc.symbol;
            if (rpc.image) base.image = rpc.image;
            if (rpc.decimals != null) base.decimals = rpc.decimals;
            if (rpc.uiAmount) base.uiAmount = rpc.uiAmount;
          } catch { /* best-effort */ }
        }

        if (!cancelled) {
          setToken(base);
          setLoadingToken(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "Failed to load token");
          setLoadingToken(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [activeAccount, mint, state.network]);

  useEffect(() => {
    if (!token) {
      setTransactions([]);
      setLoadingTxs(false);
      return;
    }

    let cancelled = false;
    (async () => {
      setLoadingTxs(true);
      try {
        const indexer = await getIndexer();
        const archExplorer = `${explorerBase}/tx/`;

        // The indexer indexes a tx against every account it touches, but
        // coverage varies: the wallet's main archAddress is the most reliable
        // bucket (signer/fee-payer), the token account ATA is also a candidate
        // when transfers move balance through it. Fetch both and dedupe.
        const walletArch =
          activeAccount?.archAddress ||
          (activeAccount?.publicKeyHex ? deriveArchAccountAddress(activeAccount.publicKeyHex) : "");

        const sources = [
          token.tokenAccount,
          walletArch && walletArch !== token.tokenAccount ? walletArch : "",
        ].filter(Boolean) as string[];

        const allResponses = await Promise.all(
          sources.map(async (addr) => {
            try {
              const res = await indexer.getAccountTransactions(addr, 50);
              return (res?.transactions ?? []) as any[];
            } catch (e) {
              console.debug("[TokenDetail] getAccountTransactions failed", addr, e);
              return [];
            }
          })
        );

        const seen = new Set<string>();
        const merged: any[] = [];
        for (const arr of allResponses) {
          for (const tx of arr) {
            if (!tx?.txid || seen.has(tx.txid)) continue;
            seen.add(tx.txid);
            merged.push(tx);
          }
        }
        console.debug(
          "[TokenDetail] candidate txs",
          { sources, count: merged.length, sample: merged.slice(0, 3) },
        );

        // Classify each tx. When chip labels don't decide, hit the per-tx
        // /instructions endpoint to look at program ids + first data byte.
        // We also require the tx to actually touch this token's account or
        // mint -- since we're now pulling from the wallet address too, the
        // list can contain unrelated activity (BTC sends, other tokens).
        const classified = await Promise.all(
          merged.map(async (tx) => {
            const fromChip = classifyFromChipLabels(tx);
            let ixs: Array<Record<string, unknown>> = [];
            let ixsLoaded = false;

            const loadIxs = async () => {
              if (ixsLoaded) return ixs;
              try {
                const res = await indexer.getTransactionInstructions(tx.txid);
                ixs = Array.isArray(res) ? res : [];
              } catch (e) {
                console.debug("[TokenDetail] getTransactionInstructions failed", tx.txid, e);
                ixs = [];
              }
              ixsLoaded = true;
              return ixs;
            };

            let isTransfer: boolean;
            if (fromChip === true) {
              isTransfer = true;
            } else if (fromChip === false) {
              isTransfer = false;
            } else {
              const loaded = await loadIxs();
              isTransfer = classifyFromInstructions(loaded);
              if (!isTransfer && loaded.length === 0) {
                // Couldn't classify at all -- be conservative and keep it.
                isTransfer = true;
              }
            }
            if (!isTransfer) return { tx, isTransfer: false };

            // Confirm the tx is relevant to *this* mint/token account.
            const mintHits =
              Array.isArray(tx?.token_mints) && tx.token_mints.includes(token.mint);
            const ttHits =
              tx?.token_transfer && (tx.token_transfer.mint === token.mint);
            let relevant = mintHits || ttHits;
            if (!relevant) {
              const loaded = await loadIxs();
              relevant = instructionsTouchAccount(loaded, token.tokenAccount, token.mint);
            }
            return { tx, isTransfer: relevant };
          })
        );

        const transferOnly = classified.filter((c) => c.isTransfer).map((c) => c.tx);
        console.debug("[TokenDetail] kept after filter", transferOnly.length);

        const detailed = await Promise.all(
          transferOnly.map(async (tx) => {
            try {
              const detail = await indexer.getTransactionDetail(tx.txid);
              return { ...tx, ...(detail as Record<string, unknown>) };
            } catch {
              return tx;
            }
          })
        );

        const items: TxItem[] = detailed.map((tx: any) => {
          const { direction, amountLabel } = deriveTransfer(tx, token.tokenAccount, token.decimals);
          return {
            txid: tx.txid,
            displayTxid: truncateAddress(formatArchId(tx.txid), 8),
            timestamp: tx.created_at || "",
            status: normalizeArchStatus(tx),
            explorerUrl: `${archExplorer}${tx.txid}`,
            direction,
            amountLabel,
          };
        });

        if (!cancelled) {
          setTransactions(items);
          setLoadingTxs(false);
        }
      } catch {
        if (!cancelled) {
          setTransactions([]);
          setLoadingTxs(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [token?.mint, token?.tokenAccount, token?.decimals, explorerBase, activeAccount?.archAddress, activeAccount?.publicKeyHex]);

  const handleSend = useCallback(() => {
    if (!token) return;
    navigate(`/send?asset=apl&mint=${encodeURIComponent(token.mint)}`);
  }, [token, navigate]);

  const handleReceive = useCallback(() => {
    navigate("/receive");
  }, [navigate]);

  if (loadingToken) {
    return (
      <>
        <div className="token-list-header">
          <button className="back-btn" onClick={() => navigate("/tokens")}>
            <BackArrow />
            <span>Tokens</span>
          </button>
          <div className="section-title" style={{ margin: 0 }}>Token</div>
          <div style={{ width: 60 }} />
        </div>
        <div className="spinner-center">
          <div className="spinner" />
        </div>
      </>
    );
  }

  if (error || !token) {
    return (
      <>
        <div className="token-list-header">
          <button className="back-btn" onClick={() => navigate("/tokens")}>
            <BackArrow />
            <span>Tokens</span>
          </button>
          <div className="section-title" style={{ margin: 0 }}>Token</div>
          <div style={{ width: 60 }} />
        </div>
        <div className="empty-state">
          <div className="empty-state-icon"><ArchIcon size={32} color="#7b68ee" /></div>
          <div>{error || "Token not found"}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="token-list-header">
        <button className="back-btn" onClick={() => navigate("/tokens")}>
          <BackArrow />
          <span>Tokens</span>
        </button>
        <div className="section-title" style={{ margin: 0 }}>{token.symbol}</div>
        <div style={{ width: 60 }} />
      </div>

      <div className="token-detail-hero">
        <div className="token-detail-icon">
          {token.image ? (
            <img src={token.image} alt={token.symbol} style={{ width: 48, height: 48, borderRadius: "50%" }} />
          ) : (
            <ArchIcon size={28} color="#7b68ee" />
          )}
        </div>
        <div className="token-detail-name">{token.name}</div>
        <div className="token-detail-sub">{token.symbol}</div>
        <div className="token-detail-balance">{token.uiAmount}</div>
      </div>

      <div className="token-detail-actions">
        <button className="btn btn-primary token-detail-action-btn" onClick={handleSend}>
          <SendIcon />
          <span>Send</span>
        </button>
        <button className="btn btn-secondary token-detail-action-btn" onClick={handleReceive}>
          <ReceiveIcon />
          <span>Receive</span>
        </button>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>Recent Activity</div>
      <div className="card">
        {loadingTxs ? (
          <div className="spinner-center" style={{ padding: 12 }}>
            <div className="spinner" />
          </div>
        ) : transactions.length === 0 ? (
          <div style={{ padding: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 12 }}>
            No transactions yet
          </div>
        ) : (
          transactions.map((tx) => {
            const dirClass =
              tx.direction === "in" ? "inbound" : tx.direction === "out" ? "outbound" : "apl";
            const dirLabel =
              tx.direction === "in" ? "Received" : tx.direction === "out" ? "Sent" : "Transfer";
            const amountClass =
              tx.direction === "in" ? "inbound" : tx.direction === "out" ? "outbound" : "";
            return (
              <a
                key={tx.txid}
                href={tx.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div className="tx-row" style={{ cursor: "pointer" }}>
                  <div className={`tx-dir ${dirClass}`}>
                    {tx.direction === "in" ? "↓" : tx.direction === "out" ? "↑" : <ArchIcon size={14} color="#7b68ee" />}
                  </div>
                  <div className="tx-info">
                    <div className="tx-label">
                      <span className="tx-direction-tag">{dirLabel}</span>{" "}
                      <span style={{ color: "var(--text-muted)" }}>{tx.displayTxid}</span>
                    </div>
                    <div className="tx-time">
                      {tx.timestamp ? formatTimestamp(tx.timestamp) : "Time unavailable"}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    {tx.amountLabel && (
                      <span className={`tx-amount ${amountClass}`}>
                        {tx.amountLabel} {token.symbol}
                      </span>
                    )}
                    <span className={`badge ${statusBadgeClass(tx.status)}`}>
                      {statusLabel(tx.status)}
                    </span>
                  </div>
                </div>
              </a>
            );
          })
        )}
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>Details</div>
      <div className="card">
        <div className="token-detail-row">
          <span className="token-detail-label">Mint</span>
          <a
            className="token-detail-value"
            href={`${explorerBase}/tokens/${token.mint}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {truncateAddress(token.mint, 8)}
          </a>
          <CopyButton text={token.mint} />
          <a
            href={`${explorerBase}/tokens/${token.mint}`}
            target="_blank"
            rel="noopener noreferrer"
            title="View in explorer"
            style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
          >
            <ExplorerIcon />
          </a>
        </div>
        {token.tokenAccount && (
          <div className="token-detail-row">
            <span className="token-detail-label">Account</span>
            <a
              className="token-detail-value"
              href={`${explorerBase}/accounts/${token.tokenAccount}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {truncateAddress(token.tokenAccount, 8)}
            </a>
            <CopyButton text={token.tokenAccount} />
            <a
              href={`${explorerBase}/accounts/${token.tokenAccount}`}
              target="_blank"
              rel="noopener noreferrer"
              title="View in explorer"
              style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
            >
              <ExplorerIcon />
            </a>
          </div>
        )}
        <div className="token-detail-row">
          <span className="token-detail-label">Decimals</span>
          <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>{token.decimals}</span>
        </div>
      </div>
    </>
  );
}
