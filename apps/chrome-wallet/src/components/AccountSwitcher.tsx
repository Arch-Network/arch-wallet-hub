import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { NetworkId, WalletAccount } from "../state/types";
import { identityAddress } from "../state/account-addresses";
import { signerInfo } from "../wallets/capabilities";
import { truncateAddress } from "../utils/format";
import { openAnsManager } from "../utils/name-service";
import CopyButton from "./CopyButton";

interface AccountSwitcherProps {
  account: WalletAccount;
  accounts: WalletAccount[];
  network: NetworkId;
  primaryName: string | null;
  onSelect: (accountId: string) => void | Promise<void>;
}

export function SignerBadge({ account }: { account: WalletAccount }) {
  const { kind, label, badge } = signerInfo(account);
  return (
    <span className="signer-badge" data-kind={kind} title={label}>
      {badge}
    </span>
  );
}

/** Names the active wallet and who signs for it; switches between wallets. */
export default function AccountSwitcher({ account, accounts, network, primaryName, onSelect }: AccountSwitcherProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const select = async (id: string) => {
    setOpen(false);
    if (id !== account.id) await onSelect(id);
  };

  return (
    <div className="account-switcher" ref={containerRef}>
      <button
        type="button"
        className="account-switcher-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${account.label} · ${signerInfo(account).label}`}
      >
        <span className="account-switcher-label">{account.label}</span>
        <SignerBadge account={account} />
        <svg className="account-switcher-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="network-menu account-menu" role="menu" aria-label="Wallets">
          {account.archAddress && (
            <div className="account-menu-current">
              <span className="account-menu-current-label">Arch address</span>
              <span className="account-menu-current-value mono" title={account.archAddress}>
                {truncateAddress(account.archAddress, 8)}
              </span>
              <CopyButton text={account.archAddress} label="Copy" />
              {primaryName && (
                <button type="button" className="link-btn" onClick={() => void openAnsManager({ view: primaryName })}>
                  {primaryName}
                </button>
              )}
            </div>
          )}

          <div className="network-menu-header">Wallets</div>
          {accounts.map((a) => {
            const active = a.id === account.id;
            const address = identityAddress(a, network);
            return (
              <button
                key={a.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`network-menu-item${active ? " active" : ""}`}
                onClick={() => void select(a.id)}
              >
                <span className="network-menu-text">
                  <span className="network-menu-label account-menu-label">
                    {a.label} <SignerBadge account={a} />
                  </span>
                  <span className="network-menu-sub mono">
                    {address ? truncateAddress(address, 8) : "No address on this network"}
                  </span>
                </span>
                {active && (
                  <span className="network-menu-check" aria-hidden>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                )}
              </button>
            );
          })}

          <div className="account-menu-actions">
            <button type="button" className="link-btn" role="menuitem" onClick={() => go("/add-wallet")}>
              Add wallet
            </button>
            <button type="button" className="link-btn" role="menuitem" onClick={() => go("/settings")}>
              Manage wallets
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
