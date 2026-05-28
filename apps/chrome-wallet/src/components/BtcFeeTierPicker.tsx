import { type FeeTier, type FeeTierId } from "../utils/btc-fee-tiers";
import { formatBtcUsd } from "../utils/format";

interface BtcFeeTierPickerProps {
  tiers: FeeTier[];
  selectedId: FeeTierId;
  /**
   * vsize of the prepared transaction in vBytes. Used to render a
   * per-tier estimated total fee. May be 0 (e.g. before the first
   * prepare completes); in that case the cards only show sat/vB.
   */
  vsize: number;
  /** Optional BTC/USD rate so the card can show "~$0.42". */
  btcUsd: number | null;
  onSelect: (id: FeeTierId) => void;
  disabled?: boolean;
}

/**
 * Three-button BTC fee picker. Each button shows the tier label, a
 * rough ETA ("~10 min"), the rate in sat/vB, and (when we have a
 * vsize + USD price) an approximate total fee in BTC and USD. The
 * picker itself is presentation-only -- selection state is owned by
 * the caller (Send.tsx) so it can re-prepare the PSBT.
 */
export default function BtcFeeTierPicker({
  tiers,
  selectedId,
  vsize,
  btcUsd,
  onSelect,
  disabled,
}: BtcFeeTierPickerProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 8,
      }}
      role="radiogroup"
      aria-label="Bitcoin fee priority"
    >
      {tiers.map((tier) => {
        const selected = tier.id === selectedId;
        const estFeeSats = vsize > 0 ? Math.ceil(vsize * tier.satPerVbyte) : 0;
        const usdLabel = estFeeSats > 0 ? formatBtcUsd(estFeeSats, btcUsd) : null;
        return (
          <button
            key={tier.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(tier.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: 4,
              padding: "10px 12px",
              borderRadius: 8,
              border: selected
                ? "1px solid var(--accent, #d8a05c)"
                : "1px solid var(--border)",
              background: selected
                ? "rgba(216, 160, 92, 0.08)"
                : "var(--bg-elevated, transparent)",
              color: "var(--text)",
              cursor: disabled ? "not-allowed" : "pointer",
              textAlign: "left",
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600 }}>{tier.label}</span>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              ~{formatEta(tier.etaMinutes)}
            </span>
            <span style={{ fontSize: 11 }}>
              {formatRate(tier.satPerVbyte)} sat/vB
            </span>
            {estFeeSats > 0 ? (
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                ≈ {estFeeSats.toLocaleString()} sats
                {usdLabel ? ` (${usdLabel})` : ""}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function formatEta(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return hours === 1 ? "1 hr" : `${hours} hr`;
}

function formatRate(rate: number): string {
  if (rate >= 100) return rate.toFixed(0);
  if (rate >= 10) return rate.toFixed(1);
  return rate.toFixed(2);
}
