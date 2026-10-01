import type { ReactNode } from "react";
import { groupAddress } from "../../utils/amount-display";

/** Full address in 4-character groups; first and last 6 characters bold. */
export function AddressText({ address }: { address: string }) {
  return (
    <span className="transfer-address">
      <span className="sr-only">{address}</span>
      {groupAddress(address).map((runs, i) => (
        <span key={i} className="transfer-address-group" aria-hidden="true">
          {runs.map((run, j) => (run.strong ? <strong key={j}>{run.text}</strong> : <span key={j}>{run.text}</span>))}
        </span>
      ))}
    </span>
  );
}

export interface TransferRecipient {
  label: string;
  /** Null for outputs with no standard address (e.g. OP_RETURN). */
  address: string | null;
  /** Amount this recipient receives, when it differs per row (PSBT outputs). */
  amount?: string;
  detail?: ReactNode;
}

interface TransferSummaryProps {
  title: string;
  amountLabel: string;
  /** Formatted amount, or null when the request's amount failed validation. */
  amount: string | null;
  symbol?: string;
  /** Shown next to the amount when it isn't in display units (e.g. "raw units"). */
  amountTag?: string;
  amountNote?: ReactNode;
  recipients: TransferRecipient[];
  fee: { value: string; note?: ReactNode };
  children?: ReactNode;
}

/**
 * The top of every value-moving approval: what leaves the wallet, where
 * it goes, and what it costs. Callers pass only values taken from the
 * dapp request or computed by the extension, never Hub display fields.
 */
export default function TransferSummary({
  title,
  amountLabel,
  amount,
  symbol,
  amountTag,
  amountNote,
  recipients,
  fee,
  children,
}: TransferSummaryProps) {
  return (
    <div className="card transfer-summary">
      <div className="transfer-summary-title">{title}</div>

      <div className="input-label">{amountLabel}</div>
      {amount === null ? (
        <div className="transfer-amount transfer-amount-invalid">Invalid amount</div>
      ) : (
        <div className="transfer-amount">
          {amount}
          {symbol && <span className="transfer-amount-symbol"> {symbol}</span>}
          {amountTag && <span className="transfer-amount-tag">{amountTag}</span>}
        </div>
      )}
      {amountNote && <div className="transfer-note">{amountNote}</div>}

      {recipients.map((r, i) => (
        <div key={i} className="transfer-row">
          <div className="transfer-row-head">
            <span className="input-label">{r.label}</span>
            {r.amount && <span className="transfer-row-amount">{r.amount}</span>}
          </div>
          {r.address ? (
            <AddressText address={r.address} />
          ) : (
            <span className="transfer-note">Non-standard output (no address)</span>
          )}
          {r.detail}
        </div>
      ))}

      <div className="transfer-row">
        <div className="transfer-row-head">
          <span className="input-label">Network fee</span>
          <span className="transfer-row-amount">{fee.value}</span>
        </div>
        {fee.note && <div className="transfer-note">{fee.note}</div>}
      </div>

      {children}
    </div>
  );
}
