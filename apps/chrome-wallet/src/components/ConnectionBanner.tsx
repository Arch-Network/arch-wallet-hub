import type { NetworkStatus } from "../hooks/useApiStatus";

interface ConnectionBannerProps {
  status: NetworkStatus;
  onRetry: () => void;
  showHubWarning?: boolean;
}

function DisconnectedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function getBannerContent(status: NetworkStatus, showHubWarning: boolean): { title: string; sub: string; variant: "error" | "warning" } | null {
  // Indexer drives the daily wallet experience (reads, faucet, BTC, RPC), so
  // it's the primary signal. Hub is only required for Turnkey wallet creation,
  // Arch/APL signing-requests, and custodial BTC — its outage is a soft warning.
  const btcDown = status.bitcoin === "disconnected";
  const archDown = status.arch === "disconnected";
  const hubDown = status.api === "disconnected";

  if (btcDown && archDown) {
    return {
      title: "Indexer unreachable",
      sub: "Check the Indexer Base URL / API key in Settings",
      variant: "error",
    };
  }

  if (btcDown) {
    return {
      title: "Bitcoin data unavailable",
      sub: "Indexer BTC endpoints aren't responding",
      variant: "warning",
    };
  }

  if (archDown) {
    return {
      title: "Arch data unavailable",
      sub: "Indexer Arch endpoints aren't responding",
      variant: "warning",
    };
  }

  if (hubDown) {
    if (!showHubWarning) return null;
    return {
      title: "Wallet Hub unavailable",
      sub: "Wallet creation and Hub-backed signing may not work",
      variant: "warning",
    };
  }

  return null;
}

export default function ConnectionBanner({ status, onRetry, showHubWarning = false }: ConnectionBannerProps) {
  const content = getBannerContent(status, showHubWarning);
  if (!content) return null;

  const isWarning = content.variant === "warning";

  return (
    <div className={`connection-banner ${isWarning ? "connection-banner-warning" : ""}`}>
      <div className="connection-banner-content">
        {isWarning ? <WarningIcon /> : <DisconnectedIcon />}
        <div className="connection-banner-text">
          <span className="connection-banner-title">{content.title}</span>
          <span className="connection-banner-sub">{content.sub}</span>
        </div>
      </div>
      <button className={`connection-banner-retry ${isWarning ? "connection-banner-retry-warning" : ""}`} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
