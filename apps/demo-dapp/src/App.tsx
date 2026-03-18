import { useMemo, useState, useCallback, useEffect } from "react";
import { HashRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { ArchNetwork } from "@arch/wallet-hub-sdk";
import type { ConnectedWallet } from "./types";
import AppShell from "./components/layout/AppShell";
import ConnectView from "./views/ConnectView";
import DashboardView from "./views/DashboardView";
import SendView from "./views/SendView";
import ReceiveView from "./views/ReceiveView";
import HistoryView from "./views/HistoryView";
import SettingsView from "./views/SettingsView";

const WALLET_STORAGE_KEY = "arch-wallet-hub:connected-wallet";
const NETWORK_STORAGE_KEY = "arch-wallet-hub:network";

function defaultEnv(key: string, fallback = ""): string {
  return (import.meta as any).env?.[key] ?? fallback;
}

function storedNetworkToArch(stored: string | null): ArchNetwork {
  if (stored === "Mainnet" || stored === "mainnet") return "mainnet";
  return "testnet";
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
  const [network, setNetwork] = useState<ArchNetwork>(
    () => storedNetworkToArch(localStorage.getItem(NETWORK_STORAGE_KEY))
  );

  const apiKey = useMemo(
    () => defaultEnv("VITE_WALLET_HUB_API_KEY", ""),
    []
  );

  const client = useMemo(
    () => new WalletHubClient({ baseUrl, network, ...(apiKey ? { apiKey } : {}) }),
    [baseUrl, apiKey, network]
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

  const handleNetworkChange = useCallback((n: ArchNetwork) => {
    setNetwork(n);
    localStorage.setItem(NETWORK_STORAGE_KEY, n === "mainnet" ? "Mainnet" : "Testnet4");
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
    <AppShell
      wallet={connectedWallet}
      network={network}
      onNetworkChange={handleNetworkChange}
      onDisconnect={handleDisconnect}
    >
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
                network={network}
                onNetworkChange={handleNetworkChange}
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
                network={network}
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
                network={network}
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
                network={network}
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
                network={network}
                externalUserId={externalUserId}
              />
            }
          />
          <Route
            path="/settings"
            element={
              <SettingsView
                wallet={connectedWallet!}
                network={network}
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
