/**
 * Renders the dapp identity strip at the top of every Approve screen.
 *
 * Phase 1.7 + 2.2: show favicon, hostname, request type, and a
 * "Connected before / New site" badge so users can quickly tell if
 * they are looking at the same dapp they've trusted historically or a
 * fresh origin trying to ride a familiar-looking icon.
 */

interface DappHeaderProps {
  origin: string;
  dappName?: string;
  iconUrl?: string;
  isReturning: boolean;
  /** Optional risk pill (info / warn / danger). Phase 2.2 risk banner. */
  risk?: { level: "info" | "warn" | "danger"; label: string };
}

function originHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export default function DappHeader({ origin, dappName, iconUrl, isReturning, risk }: DappHeaderProps) {
  const fallbackIcon = (() => {
    try {
      return `${new URL(origin).origin}/favicon.ico`;
    } catch {
      return undefined;
    }
  })();
  const icon = iconUrl || fallbackIcon;

  return (
    <div className="approve-dapp-header">
      <div className="approve-dapp-row">
        {icon ? (
          <img
            src={icon}
            alt=""
            className="approve-dapp-icon"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
        ) : (
          <div className="approve-dapp-icon-placeholder">?</div>
        )}
        <div className="approve-dapp-meta">
          <div className="approve-dapp-name" title={origin}>{dappName || originHost(origin)}</div>
          <div className="approve-dapp-origin">{originHost(origin)}</div>
        </div>
        <span className={`approve-dapp-badge ${isReturning ? "returning" : "new"}`}>
          {isReturning ? "Connected before" : "New site"}
        </span>
      </div>
      {risk && (
        <div className={`approve-risk approve-risk-${risk.level}`}>
          {risk.label}
        </div>
      )}
    </div>
  );
}
