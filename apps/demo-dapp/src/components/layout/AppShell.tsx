import { type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import type { ConnectedWallet } from "../../types";
import Header from "./Header";

type AppShellProps = {
  wallet: ConnectedWallet;
  onDisconnect: () => void;
  children: ReactNode;
};

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: "◉" },
  { to: "/send", label: "Send", icon: "↑" },
  { to: "/receive", label: "Receive", icon: "↓" },
  { to: "/history", label: "History", icon: "☰" },
  { to: "/settings", label: "Settings", icon: "⚙" },
];

export default function AppShell({ wallet, onDisconnect, children }: AppShellProps) {
  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-icon">⟠</div>
          <span className="sidebar-logo-text">Arch Hub</span>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `sidebar-link${isActive ? " sidebar-link-active" : ""}`
              }
            >
              <span className="sidebar-link-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="app-main">
        <Header wallet={wallet} onDisconnect={onDisconnect} />
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
