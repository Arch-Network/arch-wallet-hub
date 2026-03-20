import { useMemo } from "react";
import { truncateAddress } from "../utils/format";
import { reEncodeTaprootAddress } from "../utils/addressNetwork";
import CopyButton from "./CopyButton";
import type { WalletAccount, NetworkId } from "../state/types";
import type { ApiStatus } from "../hooks/useApiStatus";

interface HeaderProps {
  account: WalletAccount | null;
  network: NetworkId;
  apiStatus: ApiStatus;
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

export default function Header({ account, network, apiStatus, onLock }: HeaderProps) {
  const displayAddress = useMemo(
    () => account ? reEncodeTaprootAddress(account.btcAddress, network) : "",
    [account, network]
  );

  const isConnected = apiStatus === "connected";
  const isChecking = apiStatus === "checking";

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="header-brand">
          <img src="/arch-logo.svg" alt="Arch" className="header-logo-img" />
          <span className="header-brand-text">Arch<br/>Network</span>
        </div>

        <div className="header-controls">
          <span className={`network-pill ${!isConnected && !isChecking ? "network-pill-disconnected" : ""}`}>
            <span className={`network-dot ${!isConnected && !isChecking ? "network-dot-disconnected" : isChecking ? "network-dot-checking" : ""}`} />
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
