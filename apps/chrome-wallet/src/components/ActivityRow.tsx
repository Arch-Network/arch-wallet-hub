import { formatTimestamp, formatArchId, truncateAddress, formatBtcUsd } from "../utils/format";
import {
  type TxStatus,
  statusBadgeClass,
  statusLabel,
} from "../utils/tx-status";
import ArchIcon from "./ArchIcon";

export type ActivityRowVariant = "activity" | "compact";
export type ActivityRowType = "arch" | "apl" | "btc";
export type ActivityRowDirection = "in" | "out" | "neutral" | "unknown" | "self";

export interface ActivityRowTx {
  txid: string;
  type: ActivityRowType;
  direction: ActivityRowDirection;
  /** Short label, e.g. "Sent BTC", "Swap", "Received Token". */
  label: string;
  /** Pre-signed amount string, e.g. "+0.001 BTC" or "-1024 APL". */
  amountLabel?: string;
  /** Raw timestamp (ms string, ISO, or seconds) — formatted via formatTimestamp. */
  timestamp?: string;
  status: TxStatus;
  /** URL opened on row click (typically an explorer link). */
  explorerUrl: string;
  /** Optional pre-truncated txid for the meta row; computed if absent. */
  displayTxid?: string;
  /** BTC sats — used to compute the USD subtitle in activity variant. */
  sats?: number;
}

export interface ActivityRowProps {
  tx: ActivityRowTx;
  variant?: ActivityRowVariant;
  btcUsd?: number | null;
}

/**
 * Direction class used by `.tx-dir.<class>` for the colored chip /
 * arrow background. Compact variant falls back to "apl" (purple) for
 * neutral rows because TokenDetail is always viewed in an APL context.
 */
function dirClassFor(tx: ActivityRowTx, variant: ActivityRowVariant): string {
  if (tx.direction === "in") return "inbound";
  if (tx.direction === "out") return "outbound";
  if (variant === "compact") return "apl";
  if (tx.type === "btc") return "neutral";
  if (tx.type === "apl") return "apl";
  return "arch";
}

/**
 * Compact variant uses unicode arrow glyphs to match TokenDetail's
 * historical look; activity variant renders SVG arrows that match the
 * Dashboard / History "asset chip" treatment.
 */
function DirectionGlyph({ tx, variant }: { tx: ActivityRowTx; variant: ActivityRowVariant }) {
  if (variant === "compact") {
    const arrow = tx.direction === "in" ? "↓" : tx.direction === "out" ? "↑" : "•";
    return <>{arrow}</>;
  }

  if (tx.direction === "in") return <ArrowDown />;
  if (tx.direction === "out") return <ArrowUp />;

  if (tx.type === "btc") return <span style={{ fontSize: 14, lineHeight: 1 }}>₿</span>;
  if (tx.type === "apl") return <ArchIcon size={16} color="var(--color-usd)" />;
  return <ArchIcon size={16} color="var(--color-primary)" />;
}

function ArrowDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M19 12l-7 7-7-7" />
    </svg>
  );
}

function ArrowUp() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function amountClassName(direction: ActivityRowDirection): string {
  if (direction === "out") return "outbound";
  if (direction === "in") return "inbound";
  return "";
}

/**
 * "Success" rows go uncluttered — we only surface a badge when the tx
 * is pending, failed, or in some other not-yet-final state.
 */
function shouldShowStatusBadge(status: TxStatus): boolean {
  return status !== "success" && status !== "confirmed";
}

function ActivityVariant({ tx, btcUsd }: { tx: ActivityRowTx; btcUsd?: number | null }) {
  const usdSubtitle =
    tx.type === "btc" && tx.sats != null ? formatBtcUsd(tx.sats, btcUsd ?? null) : undefined;
  const displayTxid =
    tx.displayTxid ??
    truncateAddress(tx.type === "arch" || tx.type === "apl" ? formatArchId(tx.txid) : tx.txid, 6);

  return (
    <div className="tx-row tx-row-activity">
      <div className={`tx-dir ${dirClassFor(tx, "activity")}`}>
        <DirectionGlyph tx={tx} variant="activity" />
      </div>
      <div className="tx-info">
        <div className="tx-activity-title">
          <span className="tx-activity-label">{tx.label}</span>
          {tx.amountLabel && (
            <span className={`tx-activity-amount ${amountClassName(tx.direction)}`}>
              {tx.amountLabel}
            </span>
          )}
        </div>
        <div className="tx-activity-meta">
          <span className="tx-time">
            {tx.timestamp
              ? formatTimestamp(tx.timestamp)
              : tx.status === "pending" || tx.status === "unconfirmed"
                ? "Pending"
                : "Time unavailable"}
          </span>
          {usdSubtitle && <span className="tx-activity-usd">{usdSubtitle}</span>}
          <span className="tx-activity-ref mono">{displayTxid}</span>
        </div>
      </div>
      {shouldShowStatusBadge(tx.status) && (
        <span className={`badge ${statusBadgeClass(tx.status)}`}>
          {statusLabel(tx.status)}
        </span>
      )}
    </div>
  );
}

function CompactVariant({ tx }: { tx: ActivityRowTx }) {
  return (
    <div className="tx-row tx-row-compact">
      <div className={`tx-dir ${dirClassFor(tx, "compact")}`}>
        <DirectionGlyph tx={tx} variant="compact" />
      </div>
      <div className="tx-info">
        <div className="tx-label">{tx.label}</div>
        <div className="tx-time">{tx.timestamp ? formatTimestamp(tx.timestamp) : ""}</div>
      </div>
      <div className="tx-amount-cell">
        {tx.amountLabel && (
          <span className={`tx-amount-big ${amountClassName(tx.direction)}`}>
            {tx.amountLabel}
          </span>
        )}
        {shouldShowStatusBadge(tx.status) && (
          <span className={`badge ${statusBadgeClass(tx.status)}`}>
            {statusLabel(tx.status)}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Renders a single transaction row that links to the configured
 * `tx.explorerUrl` on click. Used by the Dashboard "Recent Activity"
 * widget, the History tab, and (in compact form) the TokenDetail
 * activity list. Centralising this here keeps swap / direction /
 * amount-class logic identical across surfaces — previously each page
 * had its own near-duplicate renderer that drifted independently.
 */
export function ActivityRow({ tx, variant = "activity", btcUsd }: ActivityRowProps) {
  return (
    <a
      href={tx.explorerUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="tx-row-link"
    >
      {variant === "compact" ? <CompactVariant tx={tx} /> : <ActivityVariant tx={tx} btcUsd={btcUsd} />}
    </a>
  );
}

export default ActivityRow;
