/**
 * Renders the dapp identity strip at the top of every Approve screen.
 *
 * Phase 1.7 + 2.2: show favicon, hostname, request type, and a
 * "Connected before / New site" badge so users can quickly tell if
 * they are looking at the same dapp they've trusted historically or a
 * fresh origin trying to ride a familiar-looking icon.
 */

import { useState } from "react";

interface DappHeaderProps {
  origin: string;
  dappName?: string;
  iconUrl?: string;
  isReturning: boolean;
  /** Optional risk pill (info / warn / danger). Phase 2.2 risk banner. */
  risk?: { level: "info" | "warn" | "danger"; label: string };
}

/** The browser-verified origin, split so a non-https scheme stays visible. */
function parseOrigin(origin: string): { scheme: string | null; host: string } {
  try {
    const url = new URL(origin);
    return { scheme: url.protocol === "https:" ? null : `${url.protocol}//`, host: url.host };
  } catch {
    return { scheme: null, host: origin };
  }
}

export default function DappHeader({ origin, dappName, iconUrl, isReturning, risk }: DappHeaderProps) {
  const [iconFailed, setIconFailed] = useState(false);
  const { scheme, host } = parseOrigin(origin);
  const fallbackIcon = (() => {
    try {
      return `${new URL(origin).origin}/favicon.ico`;
    } catch {
      return undefined;
    }
  })();
  const icon = iconUrl || fallbackIcon;
  const monogram = (host.replace(/^www\./i, "")[0] ?? "?").toUpperCase();
  // The name comes from the page itself (its tab title), so it is shown
  // only as a secondary claim under the verified host.
  const selfName = dappName?.trim();
  const showSelfName = !!selfName && selfName.toLowerCase() !== host.toLowerCase();

  return (
    <div className="approve-dapp-header">
      <div className="approve-dapp-row">
        {icon && !iconFailed ? (
          <img
            src={icon}
            alt=""
            className="approve-dapp-icon"
            referrerPolicy="no-referrer"
            onError={() => setIconFailed(true)}
          />
        ) : (
          <div className="approve-dapp-icon-placeholder" aria-hidden="true">{monogram}</div>
        )}
        <div className="approve-dapp-meta">
          <div className="approve-dapp-host" title={origin}>
            {scheme && <span className="approve-dapp-scheme">{scheme}</span>}
            {host}
          </div>
          {showSelfName && (
            <div className="approve-dapp-self-name" title={selfName}>
              Site&apos;s own name: {selfName}
            </div>
          )}
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
