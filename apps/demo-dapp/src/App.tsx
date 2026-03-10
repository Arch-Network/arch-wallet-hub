import { useMemo, useState, useCallback, useEffect } from "react";
import { HashRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { ConnectedWallet } from "./types";
import AppShell from "./components/layout/AppShell";
import ConnectView from "./views/ConnectView";
import DashboardView from "./views/DashboardView";
import SendView from "./views/SendView";
import ReceiveView from "./views/ReceiveView";
import HistoryView from "./views/HistoryView";
import SettingsView from "./views/SettingsView";

const WALLET_STORAGE_KEY = "arch-wallet-hub:connected-wallet";

function defaultEnv(key: string, fallback = ""): string {
  return (import.meta as any).env?.[key] ?? fallback;
}

export default function App() {
  const baseUrl = useMemo(
    () => defaultEnv("VITE_WALLET_HUB_BASE_URL", "http://localhost:3005/v1"),
    []
  );
  const [externalUserId] = useState(
    defaultEnv("VITE_DEFAULT_EXTERNAL_USER_ID", "demo-user-1")
  );

  const [connectedWallet, setConnectedWallet] = useState<ConnectedWallet | null>(null);

  const client = useMemo(
    () => new WalletHubClient({ baseUrl }),
    [baseUrl]
  );

  useEffect(() => {
    try {
      const stored = localStorage.getItem(WALLET_STORAGE_KEY);
      if (stored) {
        setConnectedWallet(JSON.parse(stored));
      }
    } catch {
      localStorage.removeItem(WALLET_STORAGE_KEY);
    }
  }, []);

  const handleConnect = useCallback((wallet: ConnectedWallet) => {
    setConnectedWallet(wallet);
    localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(wallet));
  }, []);

  const handleDisconnect = useCallback(() => {
    setConnectedWallet(null);
    localStorage.removeItem(WALLET_STORAGE_KEY);
  }, []);

  const authenticatedLayout = connectedWallet ? (
    <AppShell wallet={connectedWallet} onDisconnect={handleDisconnect}>
      <Outlet />
    </AppShell>
  ) : (
    <Navigate to="/" replace />
  );

  return (
    <HashRouter>
      <Routes>
        <Route
          path="/"
          element={
            connectedWallet ? (
              <Navigate to="/dashboard" replace />
            ) : (
              <ConnectView
                client={client}
                externalUserId={externalUserId}
                onConnect={handleConnect}
              />
            )
          }
        />

        <Route element={authenticatedLayout}>
          <Route
            path="/dashboard"
            element={
              <DashboardView
                client={client}
                wallet={connectedWallet!}
                externalUserId={externalUserId}
              />
            }
          />
          <Route
            path="/send"
            element={
              <SendView
                client={client}
                wallet={connectedWallet!}
                externalUserId={externalUserId}
              />
            }
          />
          <Route
            path="/receive"
            element={
              <ReceiveView
                client={client}
                wallet={connectedWallet!}
                externalUserId={externalUserId}
              />
            }
          />
          <Route
            path="/history"
            element={
              <HistoryView
                client={client}
                wallet={connectedWallet!}
                externalUserId={externalUserId}
              />
            }
          />
          <Route
            path="/settings"
            element={
              <SettingsView
                wallet={connectedWallet!}
                onDisconnect={handleDisconnect}
              />
            }
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
