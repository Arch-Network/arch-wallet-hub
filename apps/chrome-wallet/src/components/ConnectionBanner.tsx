import type { ApiStatus } from "../hooks/useApiStatus";

interface ConnectionBannerProps {
  status: ApiStatus;
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

export default function ConnectionBanner({ status, onRetry }: ConnectionBannerProps) {
  if (status !== "disconnected") return null;

  return (
    <div className="connection-banner">
      <div className="connection-banner-content">
        <DisconnectedIcon />
        <div className="connection-banner-text">
          <span className="connection-banner-title">Unable to connect to server</span>
          <span className="connection-banner-sub">Check your API settings or try again</span>
        </div>
      </div>
      <button className="connection-banner-retry" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
