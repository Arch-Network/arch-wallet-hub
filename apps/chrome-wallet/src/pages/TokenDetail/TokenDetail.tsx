import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { getIndexer } from "../../utils/indexer";
import { formatTokenAmount, formatArchId, truncateAddress, formatTimestamp, hexToBase58 } from "../../utils/format";
import { enrichTokenFromRpc } from "../../utils/arch-rpc";
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
  "Create",
  "CreateAccount",
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
  "Assign",
  "Allocate",
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

function base64ToBytes(data: unknown): number[] {
  if (typeof data !== "string" || !data) return [];
  try {
    const decoded = atob(data);
    const bytes = new Array<number>(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    return bytes;
  } catch {
    return [];
  }
}

function firstByteOfBase64(data: unknown): number | null {
  const bytes = base64ToBytes(data);
  return bytes.length ? bytes[0] : null;
}

function readLeU64(bytes: number[], offset: number): bigint {
  let result = 0n;
  for (let i = 0; i < 8; i++) {
    result |= BigInt(bytes[offset + i] ?? 0) << BigInt(8 * i);
  }
  return result;
}

function pubkeyFromAccount(account: unknown): string {
  if (typeof account === "string") return account;
  if (account && typeof account === "object") {
    const a = account as any;
    return (a.pubkey ?? a.address ?? a.account ?? "") as string;
  }
  return "";
}

interface DecodedTransfer {
  direction: "in" | "out" | "neutral";
  amount: bigint;
  decimals: number | null;
}

/**
 * Decode the first matching transfer-style instruction in a tx for our token
 * account. Returns null when no relevant transfer is found.
 *
 * APL/SPL data layout (first byte is the discriminant):
 *   3  Transfer         data=[3, amount(u64 LE)]                  accounts=[src, dst, authority]
 *   12 TransferChecked  data=[12, amount(u64 LE), decimals(u8)]   accounts=[src, mint, dst, authority]
 *   7  MintTo           data=[7, amount(u64 LE)]                  accounts=[mint, dst, authority]
 *   14 MintToChecked    data=[14, amount(u64 LE), decimals(u8)]   accounts=[mint, dst, authority]
 *   8  Burn             data=[8, amount(u64 LE)]                  accounts=[src, mint, authority]
 *   15 BurnChecked      data=[15, amount(u64 LE), decimals(u8)]   accounts=[src, mint, authority]
 */
function decodeTransferFromInstructions(
  instructions: Array<Record<string, unknown>>,
  tokenAccount: string,
): DecodedTransfer | null {
  for (const ix of instructions) {
    if (!matchesAplTokenProgram(ix?.program_id)) continue;
    const data = base64ToBytes(ix?.data);
    if (data.length < 9) continue;
    const disc = data[0];
    if (!TRANSFER_DATA_DISCRIMINANTS.has(disc)) continue;

    const accounts = Array.isArray(ix?.accounts) ? (ix.accounts as unknown[]) : [];
    const at = (i: number) => pubkeyFromAccount(accounts[i]);

    let src = "";
    let dst = "";
    let decimals: number | null = null;

    switch (disc) {
      case 3:
        src = at(0); dst = at(1);
        break;
      case 12:
        src = at(0); dst = at(2); decimals = data[9] ?? null;
        break;
      case 7:
        dst = at(1);
        break;
      case 14:
        dst = at(1); decimals = data[9] ?? null;
        break;
      case 8:
        src = at(0);
        break;
      case 15:
        src = at(0); decimals = data[9] ?? null;
        break;
      default:
        continue;
    }

    const direction: "in" | "out" | "neutral" =
      dst === tokenAccount ? "in" : src === tokenAccount ? "out" : "neutral";
    if (direction === "neutral") continue; // not our account; keep scanning

    const amount = readLeU64(data, 1);
    return { direction, amount, decimals };
  }
  return null;
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

function deriveTransferFromRow(
  tx: any,
  tokenAccount: string,
  tokenDecimals: number,
): { direction: "in" | "out" | "neutral"; amountLabel: string | null } | null {
  const tt = tx?.token_transfer;
  if (!tt || typeof tt !== "object") return null;

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

function buildAmountLabel(
  decoded: DecodedTransfer,
  fallbackDecimals: number,
): { direction: "in" | "out" | "neutral"; amountLabel: string } {
  const decimals = decoded.decimals ?? fallbackDecimals;
  const pretty = formatRawAmountWithDecimals(decoded.amount.toString(), decimals);
  const sign = decoded.direction === "out" ? "-" : decoded.direction === "in" ? "+" : "";
  return { direction: decoded.direction, amountLabel: `${sign}${pretty}` };
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
    if (!token?.tokenAccount) {
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

        // Use the richer /transactions/v2 endpoint: it returns chip labels,
        // programs, status, fee_payer, etc. on each row -- enough to classify
        // without per-tx lookups in the common case.
        const res = await indexer.getAccountTransactionsV2(token.tokenAccount, 50);
        const candidates = (res?.transactions ?? []) as any[];
        console.debug(
          "[TokenDetail] candidate txs",
          { tokenAccount: token.tokenAccount, count: candidates.length, sample: candidates.slice(0, 3) },
        );

        // Classify + decode in one pass. v2 already gives us chip labels and
        // status, so the only thing we still need /instructions for is the
        // raw amount and direction. Fetch /instructions for any tx that
        // either (a) needs classification beyond chip labels or (b) is a
        // transfer and the row didn't already carry a token_transfer summary.
        type EnrichedRow = {
          tx: any;
          isTransfer: boolean;
          fromRow?: { direction: "in" | "out" | "neutral"; amountLabel: string | null };
          decoded?: DecodedTransfer | null;
        };

        const enriched: EnrichedRow[] = await Promise.all(
          candidates.map(async (tx): Promise<EnrichedRow> => {
            const fromChip = classifyFromChipLabels(tx);
            if (fromChip === false) return { tx, isTransfer: false, decoded: null };

            let instructionsList: Array<Record<string, unknown>> | null = null;
            const loadInstructions = async () => {
              if (instructionsList !== null) return instructionsList;
              try {
                const ixs = await indexer.getTransactionInstructions(tx.txid);
                instructionsList = Array.isArray(ixs) ? ixs : [];
              } catch (e) {
                console.debug("[TokenDetail] getTransactionInstructions failed", tx.txid, e);
                instructionsList = [];
              }
              return instructionsList;
            };

            let isTransfer: boolean;
            if (fromChip === true) {
              isTransfer = true;
            } else {
              const loaded = await loadInstructions();
              const verdict = classifyFromInstructions(loaded);
              isTransfer = verdict || loaded.length === 0; // fail open
            }
            if (!isTransfer) return { tx, isTransfer: false, decoded: null };

            const fromRow = deriveTransferFromRow(tx, token.tokenAccount, token.decimals);
            if (fromRow) return { tx, isTransfer: true, fromRow };

            const loaded = await loadInstructions();
            const decoded = decodeTransferFromInstructions(loaded, token.tokenAccount);
            return { tx, isTransfer: true, decoded };
          })
        );

        const kept = enriched.filter((c) => c.isTransfer);
        console.debug("[TokenDetail] kept after filter", kept.length);

        const items: TxItem[] = kept.map(({ tx, fromRow, decoded }) => {
          let direction: "in" | "out" | "neutral" = "neutral";
          let amountLabel: string | null = null;
          if (fromRow) {
            direction = fromRow.direction;
            amountLabel = fromRow.amountLabel;
          } else if (decoded) {
            const built = buildAmountLabel(decoded, token.decimals);
            direction = built.direction;
            amountLabel = built.amountLabel;
          }
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
  }, [token?.tokenAccount, token?.decimals, explorerBase]);

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
