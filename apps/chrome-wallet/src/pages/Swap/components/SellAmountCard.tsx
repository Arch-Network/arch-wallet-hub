/**
 * Sell-side amount card. Combines a free-text amount input with a
 * token chip and a balance row that doubles as a MAX shortcut.
 */
import type { ChangeEvent } from "react";

import { sanitizeAmountInput } from "../../../utils/sanitize-amount-input";
import { formatSwapBalance } from "../../../utils/format";
import { TokenChip } from "./TokenChip";

type Props = {
  value: string;
  symbol: string;
  iconPath?: string;
  usdValue: number;
  walletConnected: boolean;
  /** Token balance available on the connected account (display units). */
  balance: number;
  /** Whether to dim the balance text (e.g. while loading). */
  isLoadingBalance?: boolean;
  /** Whether to show USD value alongside the input. */
  showUsd: boolean;
  onChange: (next: string) => void;
  onMax: () => void;
  onPickToken?: () => void;
};

function formatUsd(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function SellAmountCard({
  value,
  symbol,
  iconPath,
  usdValue,
  walletConnected,
  balance,
  isLoadingBalance,
  showUsd,
  onChange,
  onMax,
  onPickToken,
}: Props) {
  const usdLabel = showUsd ? formatUsd(usdValue) : null;
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(sanitizeAmountInput(e.target.value));
  };

  return (
    <div className="swap-card">
      <div className="swap-card-header">
        <span className="swap-card-label">You pay</span>
        <span className="swap-card-balance">
          {walletConnected ? (
            <>
              <span className={isLoadingBalance ? "swap-balance-loading" : undefined}>
                Bal {formatSwapBalance(balance, symbol)}
              </span>
              {balance > 0 && (
                <button
                  type="button"
                  className="swap-card-max"
                  onClick={onMax}
                >
                  MAX
                </button>
              )}
            </>
          ) : (
            <span className="swap-balance-loading">No wallet</span>
          )}
        </span>
      </div>

      <div className="swap-card-row">
        <input
          className="swap-card-input"
          inputMode="decimal"
          placeholder="0.00"
          value={value}
          onChange={handleChange}
          spellCheck={false}
          autoComplete="off"
        />
        <TokenChip symbol={symbol} iconPath={iconPath} onClick={onPickToken} />
      </div>

      <div className="swap-card-sub">{usdLabel ?? "\u00a0"}</div>
    </div>
  );
}
