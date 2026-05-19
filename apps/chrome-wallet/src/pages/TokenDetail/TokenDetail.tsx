import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { getIndexer } from "../../utils/indexer";
import { truncateAddress } from "../../utils/format";
import { enrichIndexerToken } from "../../utils/enrich-token";
import { addressForms } from "../../utils/arch-tx-summary";
import { normalizeArchStatus } from "../../utils/tx-status";
import CopyButton from "../../components/CopyButton";
import ArchIcon from "../../components/ArchIcon";
import { TokenIcon } from "../../components/TokenIcon";
import { ActivityRow, type ActivityRowTx } from "../../components/ActivityRow";

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

type TxKind = "transfer" | "mint" | "burn" | "swap";

interface TxItem extends ActivityRowTx {
  /** Sub-classification kept locally so the activity feed could
   * group / filter on it in the future (e.g. "show swaps only"). */
  kind: TxKind;
  counterparty: string | null;
}

function labelFor(kind: TxKind, direction: ActivityRowTx["direction"]): string {
  if (kind === "mint") return "Minted";
  if (kind === "burn") return "Burned";
  if (kind === "swap") return "Swap";
  if (direction === "in") return "Received";
  if (direction === "out") return "Sent";
  return "Transfer";
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

// The indexer's /transactions/:txid/instructions endpoint already decodes
// known programs. Each item looks like:
//   { program_id_hex, program_id_base58, action: "Token: Transfer",
//     decoded: { source, destination, amount, authority, type, ... } }
// We just have to look for transfer-ish actions and read the decoded fields.
// We match against the action string ("Token: Transfer") rather than a
// hardcoded program ID; those actions are unique to the APL Token
// program and the action-based match works for both direct calls and
// CPIs from other programs.

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
  kind: "transfer" | "mint" | "burn" | "swap";
  counterparty: string | null;
  // True when the matching token instruction was nested inside another
  // program's call (CPI). Used to relabel as "Swap" rather than "Sent".
  viaCpi: boolean;
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
  // Walk the flattened tree so we catch Transfer CPIs nested inside a
  // custom program instruction (e.g. CLAMM swaps).
  const flat = flattenInstructions(instructions);
  // Match against either form (base58 or hex). The /tree endpoint
  // returns hex addresses; the v2 row's `token_account_address` is
  // base58 — without normalizing here, swaps would silently fail to
  // match the user's ATA the same way the BTC balance bug did earlier.
  const accountForms = addressForms(tokenAccount);

  for (const ix of flat) {
    const action = typeof ix?.action === "string" ? ix.action : "";
    if (!TOKEN_TRANSFER_ACTIONS.has(action)) continue;

    const decoded = (ix?.decoded ?? {}) as Record<string, unknown>;
    const src = typeof decoded.source === "string" ? decoded.source : "";
    const dst = typeof decoded.destination === "string" ? decoded.destination : "";
    const direction: "in" | "out" | "neutral" =
      accountForms.has(dst) ? "in"
      : accountForms.has(src) ? "out"
      : "neutral";
    if (direction === "neutral") continue; // not our account; keep scanning

    const amount = toBigInt(decoded.amount);
    if (amount === null) continue;

    const decimals = typeof decoded.decimals === "number" ? decoded.decimals : null;

    const depth = typeof ix.__depth === "number" ? ix.__depth : 0;
    const viaCpi = depth > 0;
    let kind: DecodedTransfer["kind"] = "transfer";
    if (action.startsWith("Token: MintTo")) kind = "mint";
    else if (action.startsWith("Token: Burn")) kind = "burn";
    else if (viaCpi) kind = "swap";

    const counterparty = direction === "in" ? (src || null) : (dst || null);

    return { direction, amount, decimals, kind, counterparty, viaCpi };
  }
  return null;
}

// Returns: true if it IS a transfer, false if it's PURELY admin, null if
// ambiguous (custom CPIs / unknown labels).
//
// Fail-open by design: when we don't recognize every label as
// known-admin, return null so the caller falls through to decoding —
// CPI-only token movements (e.g. CLAMM swaps where the top-level
// instruction is "Custom Instruction" and the actual `Token: Transfer`
// happens via CPI) must NOT be dropped on label heuristics alone.
function classifyFromChipLabels(tx: any): boolean | null {
  if (tx?.token_transfer && typeof tx.token_transfer === "object") return true;
  const labels = tx?.instructions;
  if (!Array.isArray(labels) || labels.length === 0) return null;

  let sawTransfer = false;
  let allKnownAdmin = true;
  for (const label of labels) {
    if (typeof label !== "string") {
      allKnownAdmin = false;
      continue;
    }
    if (TRANSFER_INSTRUCTION_LABELS.has(label)) {
      sawTransfer = true;
      allKnownAdmin = false;
    } else if (!NON_TRANSFER_LABELS.has(label)) {
      // Anything unrecognized (e.g. "CustomInstruction", a CLAMM swap
      // chip, a custom program's action) escapes the "pure admin" trap.
      allKnownAdmin = false;
    }
  }
  if (sawTransfer) return true;
  if (allKnownAdmin) return false;
  return null;
}

// Flattens an instructions response so the transfer-detection logic
// works regardless of the indexer's shape. Tries every container
// convention we've seen in the wild:
//
//   - Arch indexer /tree: `{ depth, children }` (preferred — depth is
//     authoritative)
//   - Solana-style: `{ inner_instructions }` or `{ innerInstructions }`
//   - Custom shapes: `{ cpi }`, `{ children }`, or a flat list with a
//     `stack_height` / `stackHeight` field (depth ≈ stack_height - 1).
//
// Each emitted node carries `__depth` (0 = top-level, >0 = CPI) so
// callers can distinguish CPI movements from direct top-level calls.
function flattenInstructions(
  instructions: Array<Record<string, unknown>>,
): Array<Record<string, unknown> & { __depth: number }> {
  const out: Array<Record<string, unknown> & { __depth: number }> = [];
  const walk = (item: Record<string, unknown> | null | undefined, depth: number) => {
    if (!item) return;
    // Trust the indexer's authoritative `depth` field when present
    // (Arch /tree). Otherwise fall back to our walker-computed depth.
    const explicit = typeof item.depth === "number" ? item.depth : null;
    const effective = explicit ?? depth;
    out.push({ ...item, __depth: effective });

    const candidates = [
      item.children,
      item.inner_instructions,
      item.innerInstructions,
      item.cpi,
    ];
    for (const c of candidates) {
      if (Array.isArray(c)) {
        for (const sub of c) walk(sub as Record<string, unknown>, effective + 1);
      }
    }
  };
  for (const ix of instructions) walk(ix, 0);
  // Belt + suspenders: handle Solana-style "flat with stack_height"
  // shapes, in case an indexer version inlines children instead of
  // nesting them.
  for (const node of out) {
    if (node.__depth === 0) {
      const sh = node.stack_height ?? node.stackHeight;
      if (typeof sh === "number" && sh > 1) node.__depth = sh - 1;
    }
  }
  return out;
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

        const enriched = await enrichIndexerToken(raw, state.network, indexer);

        if (!cancelled) {
          setToken({
            mint: enriched.mint,
            // TokenDetail historically treated an empty symbol as
            // "show truncated mint header" — preserve that contract
            // for now by mapping the fallback source back to "".
            symbol: enriched.source === "fallback" ? "" : enriched.symbol,
            name: enriched.name,
            balance: enriched.balance,
            decimals: enriched.decimals,
            uiAmount: enriched.uiAmount,
            image: enriched.image,
            tokenAccount: enriched.tokenAccount,
          });
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
            // Only drop on chip labels when we're CERTAIN it's a pure
            // admin op (e.g. Create ATA, SetAuthority). Anything
            // ambiguous (Custom Instructions, unrecognized labels) MUST
            // fall through — those are how CPI-only swaps appear.
            if (fromChip === false) return { tx, isTransfer: false, decoded: null };

            let instructionsList: Array<Record<string, unknown>> | null = null;
            const loadInstructions = async () => {
              if (instructionsList !== null) return instructionsList;
              // Use `/tree`, not `/instructions`: the tree endpoint
              // returns the full CPI hierarchy (each node has a
              // `children` array), which is the only data path that
              // exposes Token: Transfer instructions executed via CPI
              // from custom programs like CLAMM. `/instructions` only
              // surfaces the flat top-level row — fine for direct
              // transfers, blind to swaps.
              try {
                const ixs = await indexer.getTransactionTree(tx.txid);
                instructionsList = Array.isArray(ixs) ? ixs : [];
              } catch (e) {
                console.debug("[TokenDetail] getTransactionTree failed", tx.txid, e);
                // Fall back to the flat endpoint so direct transfers
                // still resolve when the indexer's /tree route is
                // unavailable (older indexer versions, or transient
                // routing errors).
                try {
                  const flat = await indexer.getTransactionInstructions(tx.txid);
                  instructionsList = Array.isArray(flat) ? flat : [];
                } catch (e2) {
                  console.debug(
                    "[TokenDetail] getTransactionInstructions fallback failed",
                    tx.txid,
                    e2,
                  );
                  instructionsList = [];
                }
              }
              return instructionsList;
            };

            // We always want to attempt a decode so we can render the
            // amount / direction. If the chip already says transfer we
            // keep it; otherwise we use the decoded result as the
            // strongest signal (any APL token movement touching OUR
            // token account at any depth, including CPIs).
            const fromRow = deriveTransferFromRow(tx, token.tokenAccount, token.decimals);
            if (fromChip === true && fromRow) {
              return { tx, isTransfer: true, fromRow };
            }

            const loaded = await loadInstructions();
            const decoded = decodeTransferFromInstructions(loaded, token.tokenAccount);
            if (decoded) {
              return { tx, isTransfer: true, decoded };
            }

            // No decoded match. Fall back to chip-level signals: keep it
            // only if the chip explicitly said transfer, or we have a
            // row-level token_transfer summary. This avoids surfacing
            // unrelated txs that happened to come back from the v2 feed.
            if (fromChip === true) {
              return { tx, isTransfer: true, fromRow: fromRow ?? undefined };
            }

            return { tx, isTransfer: false, decoded: null };
          })
        );

        const kept = enriched.filter((c) => c.isTransfer);
        console.debug("[TokenDetail] kept after filter", kept.length);

        const items: TxItem[] = kept.map(({ tx, fromRow, decoded }) => {
          let direction: ActivityRowTx["direction"] = "neutral";
          let amountLabel: string | undefined;
          let kind: TxKind = "transfer";
          let counterparty: string | null = null;
          if (fromRow) {
            direction = fromRow.direction;
            amountLabel = fromRow.amountLabel ?? undefined;
            kind = (fromRow as any).kind ?? kind;
            counterparty = (fromRow as any).counterparty ?? null;
          } else if (decoded) {
            direction = decoded.direction;
            amountLabel = buildAmountLabel(decoded, token.decimals);
            kind = decoded.kind;
            counterparty = decoded.counterparty;
          }
          return {
            txid: tx.txid,
            type: "apl",
            direction,
            label: labelFor(kind, direction),
            amountLabel,
            timestamp: tx.created_at || "",
            status: normalizeArchStatus(tx),
            explorerUrl: `${archExplorer}${tx.txid}`,
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
          <TokenIcon image={token.image} symbol={token.symbol || "?"} size={48} />
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
          transactions.map((tx) => (
            <ActivityRow key={tx.txid} tx={tx} variant="compact" />
          ))
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
