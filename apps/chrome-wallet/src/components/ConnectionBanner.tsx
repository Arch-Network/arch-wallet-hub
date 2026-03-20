import type { NetworkStatus } from "../hooks/useApiStatus";

interface ConnectionBannerProps {
  status: NetworkStatus;
  onRetry: () => void;
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

function getBannerContent(status: NetworkStatus): { title: string; sub: string; variant: "error" | "warning" } | null {
  if (status.api === "disconnected") {
    return {
      title: "Unable to connect to server",
      sub: "Check your API settings or try again",
      variant: "error",
    };
  }

  if (status.api === "checking") return null;

  const btcDown = status.bitcoin === "disconnected";
  const archDown = status.arch === "disconnected";

  if (btcDown && archDown) {
    return {
      title: "Bitcoin and Arch networks unavailable",
      sub: "Both networks are currently unreachable",
      variant: "error",
    };
  }

  if (btcDown) {
    return {
      title: "Bitcoin network unavailable",
      sub: "BTC features may not work correctly",
      variant: "warning",
    };
  }

  if (archDown) {
    return {
      title: "Arch Network unavailable",
      sub: "ARCH and token features may not work correctly",
      variant: "warning",
    };
  }

  return null;
}

export default function ConnectionBanner({ status, onRetry }: ConnectionBannerProps) {
  const content = getBannerContent(status);
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
