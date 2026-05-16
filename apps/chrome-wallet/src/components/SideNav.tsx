import { useNavigate, useLocation } from "react-router-dom";
import { NAV_ITEMS } from "./nav-items";
import type { NetworkId } from "../state/types";

const NETWORK_LABELS: Record<NetworkId, string> = {
  testnet4: "Testnet",
  mainnet: "Mainnet",
};

interface SideNavProps {
  network: NetworkId;
}

export default function SideNav({ network }: SideNavProps) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <aside className="app-sidebar" aria-label="Primary navigation">
      <div className="side-nav-brand">
        <img src="/arch-logo.svg" alt="" className="side-nav-brand-logo" />
        <div className="side-nav-brand-text">
          <span className="side-nav-brand-name">Arch Wallet</span>
          <span className="side-nav-brand-network">{NETWORK_LABELS[network]}</span>
        </div>
      </div>

      {NAV_ITEMS.map((item) => {
        const isActive = location.pathname === item.path;
        return (
          <button
            key={item.path}
            className={`side-nav-item ${isActive ? "active" : ""}`}
            onClick={() => navigate(item.path)}
          >
            <span className="side-nav-icon">
              <item.Icon active={isActive} />
            </span>
            {item.label}
          </button>
        );
      })}

      <div className="side-nav-spacer" />
      <div className="side-nav-footer">v0.1.5</div>
    </aside>
  );
}
