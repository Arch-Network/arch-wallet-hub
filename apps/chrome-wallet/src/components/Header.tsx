import { useEffect, useMemo, useRef, useState } from "react";
import { truncateAddress } from "../utils/format";
import { reEncodeTaprootAddress } from "../utils/addressNetwork";
import { hasConfirmedMainnet, markMainnetConfirmed } from "../utils/mainnet-confirm";
import { useWideMode } from "../hooks/useWideMode";
import CopyButton from "./CopyButton";
import type { WalletAccount, NetworkId } from "../state/types";
import type { NetworkStatus } from "../hooks/useApiStatus";

interface HeaderProps {
  account: WalletAccount | null;
  network: NetworkId;
  networkStatus: NetworkStatus;
  onLock: () => void;
  onNetworkChange?: (network: NetworkId) => void | Promise<void>;
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="10" width="14" height="10" rx="2.5" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function dotClass(ns: NetworkStatus): string {
  if (ns.bitcoin === "checking" || ns.arch === "checking") return "network-dot-checking";
  if (ns.bitcoin === "disconnected" && ns.arch === "disconnected") return "network-dot-disconnected";
  if (ns.bitcoin === "disconnected" || ns.arch === "disconnected") return "network-dot-degraded";
  return "";
}

function pillClass(ns: NetworkStatus): string {
  if (ns.bitcoin === "disconnected" && ns.arch === "disconnected") return "network-pill-disconnected";
  if (ns.bitcoin === "disconnected" || ns.arch === "disconnected") return "network-pill-degraded";
  return "";
}

const NETWORK_OPTIONS: { id: NetworkId; label: string; sublabel: string }[] = [
  { id: "testnet4", label: "Testnet", sublabel: "Bitcoin Testnet4 + Arch Testnet" },
  { id: "mainnet", label: "Mainnet", sublabel: "Bitcoin Mainnet + Arch Mainnet" },
];

interface NetworkSwitcherProps {
  network: NetworkId;
  networkStatus: NetworkStatus;
  onChange: (n: NetworkId) => void | Promise<void>;
}

function NetworkSwitcher({ network, networkStatus, onChange }: NetworkSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [confirmingMainnet, setConfirmingMainnet] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open && !confirmingMainnet) return;
    const handlePointer = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirmingMainnet(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        setConfirmingMainnet(false);
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, confirmingMainnet]);

  const handleSelect = async (next: NetworkId) => {
    setOpen(false);
    if (next === network) return;
    if (next === "mainnet") {
      // Phase 2.4: confirm the first mainnet switch on this install.
      const confirmed = await hasConfirmedMainnet();
      if (!confirmed) {
        setConfirmingMainnet(true);
        return;
      }
    }
    await onChange(next);
  };

  const confirmMainnet = async () => {
    setConfirmingMainnet(false);
    await markMainnetConfirmed();
    await onChange("mainnet");
  };

  return (
    <div className="network-switcher" ref={containerRef}>
      <button
        type="button"
        className={`network-pill network-pill-button ${pillClass(networkStatus)}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch network"
      >
        <span className={`network-dot ${dotClass(networkStatus)}`} />
        <span className="network-pill-label">
          {network === "testnet4" ? "TESTNET" : "MAINNET"}
        </span>
        <span className="network-pill-caret"><ChevronDownIcon /></span>
      </button>

      {open && (
        <div className="network-menu" role="listbox" aria-label="Network">
          <div className="network-menu-header">Choose network</div>
          {NETWORK_OPTIONS.map((opt) => {
            const active = opt.id === network;
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={active}
                className={`network-menu-item${active ? " active" : ""}`}
                onClick={() => handleSelect(opt.id)}
              >
                <span className={`network-menu-dot ${opt.id === "testnet4" ? "testnet" : "mainnet"}`} />
                <span className="network-menu-text">
                  <span className="network-menu-label">{opt.label}</span>
                  <span className="network-menu-sub">{opt.sublabel}</span>
                </span>
                {active && <span className="network-menu-check" aria-hidden><CheckIcon /></span>}
              </button>
            );
          })}
        </div>
      )}

      {confirmingMainnet && (
        <div className="network-menu" role="alertdialog">
          <div className="network-menu-header" style={{ color: "var(--danger)" }}>
            Switch to Mainnet?
          </div>
          <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-secondary)" }}>
            Mainnet uses real funds. Make sure the Hub URL is HTTPS and that you intend to use real Bitcoin and ARCH.
          </div>
          <div style={{ display: "flex", gap: 8, padding: "8px 12px 12px" }}>
            <button className="btn btn-sm btn-secondary" style={{ flex: 1 }} onClick={() => setConfirmingMainnet(false)}>
              Cancel
            </button>
            <button className="btn btn-sm btn-primary" style={{ flex: 1 }} onClick={confirmMainnet}>
              Switch
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Header({ account, network, networkStatus, onLock, onNetworkChange }: HeaderProps) {
  const displayAddress = useMemo(
    () => account ? reEncodeTaprootAddress(account.btcAddress, network) : "",
    [account, network]
  );
  const wide = useWideMode(720);
  const veryWide = useWideMode(1000);
  const addrChars = veryWide ? 16 : wide ? 10 : 5;

  return (
    <header className="app-header">
      <div className="header-inner">
        <div className="header-brand">
          <img src="/arch-logo-orange.svg" alt="Arch Network" className="header-logo-img header-logo-light" />
          <img src="/arch-logo-cream.svg" alt="Arch Network" className="header-logo-img header-logo-dark" />
        </div>

        <div className="header-controls">
          {onNetworkChange ? (
            <NetworkSwitcher network={network} networkStatus={networkStatus} onChange={onNetworkChange} />
          ) : (
            <span className={`network-pill ${pillClass(networkStatus)}`}>
              <span className={`network-dot ${dotClass(networkStatus)}`} />
              {network === "testnet4" ? "TESTNET" : "MAINNET"}
            </span>
          )}

          {account && displayAddress && (
            <span className="address-chip" title={displayAddress}>
              {truncateAddress(displayAddress, addrChars)}
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
