import type { AccountAddress } from "../../state/types";
import type { AddressSats } from "../../utils/btc-holdings";
import { formatBtcAmount, truncateAddress } from "../../utils/format";

function purposeLabel(record: AccountAddress): string {
  const payment = record.purposes.includes("payment");
  const ordinals = record.purposes.includes("ordinals");
  if (payment && ordinals) return "Bitcoin";
  return payment ? "Payment" : "Ordinals";
}

/**
 * One row per Bitcoin address for accounts that have several (Xverse's
 * payment + ordinals). Sends spend from the Taproot identity address
 * only, so a balance elsewhere is labelled as spendable in the source
 * wallet instead of implying Arch Wallet can move it.
 */
export function BtcAddressBreakdown({
  records,
  byAddress,
  identity,
  signerLabel,
}: {
  records: AccountAddress[];
  byAddress: Record<string, AddressSats | null>;
  identity: string | null;
  signerLabel: string;
}) {
  if (records.length < 2) return null;
  const elsewhere = records.some((r) => r.address !== identity && (byAddress[r.address]?.confirmed ?? 0) > 0);
  return (
    <>
      {records.map((r) => {
        const sats = byAddress[r.address];
        return (
          <div className="btc-breakdown-row" key={r.address} title={r.address}>
            <span className="btc-breakdown-label">
              {purposeLabel(r)} · {truncateAddress(r.address, 4)}
            </span>
            <span className="btc-breakdown-value">
              {sats ? formatBtcAmount(sats.confirmed + sats.pending) : "Unavailable"}
            </span>
          </div>
        );
      })}
      {elsewhere && (
        <div className="btc-breakdown-note">
          Arch Wallet sends BTC from your Taproot address only. Use {signerLabel} to spend from the others.
        </div>
      )}
    </>
  );
}
