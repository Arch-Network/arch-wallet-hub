import { useMemo } from "react";
import { truncateAddress } from "../utils/format";
import { reEncodeTaprootAddress } from "../utils/addressNetwork";
import CopyButton from "./CopyButton";
import type { WalletAccount, NetworkId } from "../state/types";
import type { NetworkStatus } from "../hooks/useApiStatus";

interface HeaderProps {
  account: WalletAccount | null;
  network: NetworkId;
  networkStatus: NetworkStatus;
  onLock: () => void;
}

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5cb85c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function dotClass(ns: NetworkStatus): string {
  if (ns.api === "checking") return "network-dot-checking";
  if (ns.api === "disconnected") return "network-dot-disconnected";
  if (ns.bitcoin === "disconnected" && ns.arch === "disconnected") return "network-dot-disconnected";
  if (ns.bitcoin === "disconnected" || ns.arch === "disconnected") return "network-dot-degraded";
  return "";
}

function pillClass(ns: NetworkStatus): string {
  if (ns.api === "disconnected") return "network-pill-disconnected";
  if (ns.bitcoin === "disconnected" && ns.arch === "disconnected") return "network-pill-disconnected";
  if (ns.bitcoin === "disconnected" || ns.arch === "disconnected") return "network-pill-degraded";
  return "";
}

export default function Header({ account, network, networkStatus, onLock }: HeaderProps) {
  const displayAddress = useMemo(
    () => account ? reEncodeTaprootAddress(account.btcAddress, network) : "",
    [account, network]
  );

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="header-brand">
          <img src="/arch-logo.svg" alt="Arch" className="header-logo-img" />
          <span className="header-brand-text">Arch<br/>Network</span>
        </div>

        <div className="header-controls">
          <span className={`network-pill ${pillClass(networkStatus)}`}>
            <span className={`network-dot ${dotClass(networkStatus)}`} />
            {network === "testnet4" ? "TESTNET" : "MAINNET"}
          </span>

          {account && displayAddress && (
            <span className="address-chip">
              {truncateAddress(displayAddress, 4)}
              <CopyButton text={displayAddress} />
            </span>
          )}

          <button className="header-lock-btn" onClick={onLock} title="Lock wallet">
            <LockIcon />
          </button>
        </div>
      </div>
    </header>
  );
}
