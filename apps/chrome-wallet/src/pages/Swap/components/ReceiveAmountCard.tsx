/**
 * Receive-side amount card. Read-only display of the quoted buy
 * amount, the matching USD value, and a refreshing-shimmer when the
 * engine is fetching a new quote.
 */
import { formatSwapAmount, formatSwapBalance } from "../../../utils/format";
import { TokenChip } from "./TokenChip";

type Props = {
  amount: number;
  symbol: string;
  iconPath?: string;
  usdValue: number;
  showUsd: boolean;
  isRefreshing: boolean;
  walletConnected: boolean;
  balance: number;
  onPickToken?: () => void;
};

function formatUsd(usd: number): string | null {
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function ReceiveAmountCard({
  amount,
  symbol,
  iconPath,
  usdValue,
  showUsd,
  isRefreshing,
  walletConnected,
  balance,
  onPickToken,
}: Props) {
  const usdLabel = showUsd ? formatUsd(usdValue) : null;
  return (
    <div className="swap-card swap-card-receive">
      <div className="swap-card-header">
        <span className="swap-card-label">You receive</span>
        {walletConnected && (
          <span className="swap-card-balance">
            Bal {formatSwapBalance(balance, symbol)}
          </span>
        )}
      </div>
      <div className="swap-card-row">
        <span
          className={`swap-card-output ${
            isRefreshing ? "swap-card-output-refreshing" : ""
          }`}
        >
          {formatSwapAmount(amount, symbol)}
        </span>
        <TokenChip symbol={symbol} iconPath={iconPath} onClick={onPickToken} />
      </div>
      <div className="swap-card-sub">{usdLabel ?? "\u00a0"}</div>
    </div>
  );
}
