import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { getIndexer } from "../../utils/indexer";
import { formatTokenAmount, truncateAddress, formatTimestamp } from "../../utils/format";
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
  timestamp: string;
  status: TxStatus;
  explorerUrl: string;
  direction: "in" | "out" | "neutral";
  amountLabel: string | null;
  kind: "transfer" | "mint" | "burn";
  counterparty: string | null;
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

const APL_TOKEN_PROGRAM_ID_HEX =
  "06ddf6e1b9ea84412c10b8df021c100fc8871907c309c33535de209c341763bf";

function matchesAplTokenProgram(ix: Record<string, unknown> | null | undefined): boolean {
  if (!ix) return false;
  const hex = typeof ix.program_id_hex === "string" ? ix.program_id_hex.toLowerCase() : "";
  if (hex === APL_TOKEN_PROGRAM_ID_HEX) return true;
  // Legacy fallback when servers don't split the field.
  const generic = typeof ix.program_id === "string" ? ix.program_id.toLowerCase() : "";
  return generic === APL_TOKEN_PROGRAM_ID_HEX;
}

// The indexer's /transactions/:txid/instructions endpoint already decodes
// known programs. Each item looks like:
//   { program_id_hex, program_id_base58, action: "Token: Transfer",
//     decoded: { source, destination, amount, authority, type, ... } }
// We just have to look for transfer-ish actions and read the decoded fields.

const TOKEN_TRANSFER_ACTIONS = new Set([
  "Token: Transfer",
  "Token: TransferChecked",
  "Token: MintTo",
  "Token: MintToChecked",
  "Token: Burn",
  "Token: BurnChecked",
]);

interface DecodedTransfer {
  direction: "in" | "out" | "neutral";
  amount: bigint;
  decimals: number | null;
  kind: "transfer" | "mint" | "burn";
  counterparty: string | null;
}

function toBigInt(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}

function decodeTransferFromInstructions(
  instructions: Array<Record<string, unknown>>,
  tokenAccount: string,
): DecodedTransfer | null {
  for (const ix of instructions) {
    const action = typeof ix?.action === "string" ? ix.action : "";
    if (!TOKEN_TRANSFER_ACTIONS.has(action)) continue;

    const decoded = (ix?.decoded ?? {}) as Record<string, unknown>;
    const src = typeof decoded.source === "string" ? decoded.source : "";
    const dst = typeof decoded.destination === "string" ? decoded.destination : "";
    const direction: "in" | "out" | "neutral" =
      dst === tokenAccount ? "in" : src === tokenAccount ? "out" : "neutral";
    if (direction === "neutral") continue; // not our account; keep scanning

    const amount = toBigInt(decoded.amount);
    if (amount === null) continue;

    const decimals = typeof decoded.decimals === "number" ? decoded.decimals : null;

    let kind: "transfer" | "mint" | "burn" = "transfer";
    if (action.startsWith("Token: MintTo")) kind = "mint";
    else if (action.startsWith("Token: Burn")) kind = "burn";

    const counterparty = direction === "in" ? (src || null) : (dst || null);

    return { direction, amount, decimals, kind, counterparty };
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

// Authoritative classifier using per-tx /instructions data. Returns true if
// any APL token instruction's action is a transfer-y label.
function classifyFromInstructions(instructions: Array<Record<string, unknown>>): boolean {
  for (const ix of instructions) {
    if (!matchesAplTokenProgram(ix)) continue;
    const action = typeof ix?.action === "string" ? ix.action : "";
    if (TOKEN_TRANSFER_ACTIONS.has(action)) return true;
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
): { direction: "in" | "out" | "neutral"; amountLabel: string | null; kind: "transfer" | "mint" | "burn"; counterparty: string | null } | null {
  const tt = tx?.token_transfer;
  if (!tt || typeof tt !== "object") return null;

  const src = (tt.source_account ?? "") as string;
  const dst = (tt.destination_account ?? "") as string;
  const direction: "in" | "out" | "neutral" =
    dst === tokenAccount ? "in" : src === tokenAccount ? "out" : "neutral";

  const rawAmount = (tt.amount ?? "") as string;
  const decimals = typeof tt.decimals === "number" ? tt.decimals : tokenDecimals;
  const pretty = rawAmount ? formatRawAmountWithDecimals(String(rawAmount), decimals) : null;
  const sign = direction === "out" ? "-" : direction === "in" ? "+" : "";
  const counterparty = direction === "in" ? (src || null) : (dst || null);

  return {
    direction,
    amountLabel: pretty ? `${sign}${pretty}` : null,
    kind: "transfer",
    counterparty,
  };
}

function buildAmountLabel(decoded: DecodedTransfer, fallbackDecimals: number): string {
  const decimals = decoded.decimals ?? fallbackDecimals;
  const pretty = formatRawAmountWithDecimals(decoded.amount.toString(), decimals);
  const sign = decoded.direction === "out" ? "-" : decoded.direction === "in" ? "+" : "";
  return `${sign}${pretty}`;
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
  const [showDetails, setShowDetails] = useState(false);

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
          // Only treat as a real symbol if the indexer/RPC gave us one.
          symbol: (raw.symbol as string) || "",
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
          let kind: "transfer" | "mint" | "burn" = "transfer";
          let counterparty: string | null = null;
          if (fromRow) {
            direction = fromRow.direction;
            amountLabel = fromRow.amountLabel;
            kind = fromRow.kind;
            counterparty = fromRow.counterparty;
          } else if (decoded) {
            direction = decoded.direction;
            amountLabel = buildAmountLabel(decoded, token.decimals);
            kind = decoded.kind;
            counterparty = decoded.counterparty;
          }
          return {
            txid: tx.txid,
            timestamp: tx.created_at || "",
            status: normalizeArchStatus(tx),
            explorerUrl: `${archExplorer}${tx.txid}`,
            direction,
            amountLabel,
            kind,
            counterparty,
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
        <div className="section-title" style={{ margin: 0 }}>{token.symbol || token.name}</div>
        <div style={{ width: 60 }} />
      </div>

      <div className="token-detail-grid">
      <div className="token-detail-summary">
      <div className="token-detail-hero">
        <div className="token-detail-icon">
          {token.image ? (
            <img src={token.image} alt={token.name} style={{ width: 48, height: 48, borderRadius: "50%" }} />
          ) : (
            <ArchIcon size={28} color="#7b68ee" />
          )}
        </div>
        <div className="token-detail-name">{token.name}</div>
        <div className="token-detail-balance">
          {token.uiAmount}
          {token.symbol && <span className="token-detail-balance-symbol"> {token.symbol}</span>}
        </div>
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
      </div>

      <div className="token-detail-activity">
      <div className="section-title" style={{ marginTop: 0 }}>Recent Activity</div>
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
            const amountClass =
              tx.direction === "in" ? "inbound" : tx.direction === "out" ? "outbound" : "";
            const label =
              tx.kind === "mint" ? "Minted"
              : tx.kind === "burn" ? "Burned"
              : tx.direction === "in" ? "Received"
              : tx.direction === "out" ? "Sent"
              : "Transfer";
            const showStatus = tx.status !== "success" && tx.status !== "confirmed";
            const arrow = tx.direction === "in" ? "↓" : tx.direction === "out" ? "↑" : "•";
            return (
              <a
                key={tx.txid}
                href={tx.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="tx-row-link"
              >
                <div className="tx-row tx-row-compact">
                  <div className={`tx-dir ${dirClass}`}>{arrow}</div>
                  <div className="tx-info">
                    <div className="tx-label">{label}</div>
                    <div className="tx-time">
                      {tx.timestamp ? formatTimestamp(tx.timestamp) : ""}
                    </div>
                  </div>
                  <div className="tx-amount-cell">
                    {tx.amountLabel && (
                      <span className={`tx-amount-big ${amountClass}`}>{tx.amountLabel}</span>
                    )}
                    {showStatus && (
                      <span className={`badge ${statusBadgeClass(tx.status)}`}>
                        {statusLabel(tx.status)}
                      </span>
                    )}
                  </div>
                </div>
              </a>
            );
          })
        )}
      </div>
      </div>

      <div className="token-detail-extras">
      <button
        className="token-detail-toggle"
        onClick={() => setShowDetails((v) => !v)}
        aria-expanded={showDetails}
      >
        <span>Details</span>
        <span className={`token-detail-toggle-chevron${showDetails ? " open" : ""}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>
      {showDetails && (
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
      )}
      </div>
      </div>
    </>
  );
}
