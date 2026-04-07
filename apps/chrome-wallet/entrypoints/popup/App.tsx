import { useEffect, useRef, useState } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useWallet } from "../../src/hooks/useWallet";
import Header from "../../src/components/Header";
import ConnectionBanner from "../../src/components/ConnectionBanner";
import NavBar from "../../src/components/NavBar";
import { useApiStatus } from "../../src/hooks/useApiStatus";
import Onboarding from "../../src/pages/Onboarding/Onboarding";
import Unlock from "../../src/pages/Unlock/Unlock";
import Dashboard from "../../src/pages/Dashboard/Dashboard";
import Send from "../../src/pages/Send/Send";
import Receive from "../../src/pages/Receive/Receive";
import History from "../../src/pages/History/History";
import TokenList from "../../src/pages/TokenList/TokenList";
import Approve from "../../src/pages/Approve/Approve";
import Settings from "../../src/pages/Settings/Settings";

const ROUTE_STORAGE_KEY = "arch_wallet_last_route";
const VALID_ROUTES = ["/dashboard", "/send", "/receive", "/history", "/tokens", "/settings"];

function RouteRestorer() {
  const location = useLocation();
  const navigate = useNavigate();
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (location.pathname.startsWith("/approve/")) return;
    chrome.storage.local.get(ROUTE_STORAGE_KEY).then((result) => {
      const saved = result[ROUTE_STORAGE_KEY];
      if (saved && VALID_ROUTES.includes(saved) && saved !== location.pathname) {
        navigate(saved, { replace: true });
      }
    });
  }, []);

  useEffect(() => {
    if (VALID_ROUTES.includes(location.pathname)) {
      chrome.storage.local.set({ [ROUTE_STORAGE_KEY]: location.pathname });
    }
  }, [location.pathname]);

  return null;
}

function AppRoutes() {
  const { state, activeAccount, loading, lock, unlock, refresh } = useWallet();
  const { status: networkStatus, retry: retryApi } = useApiStatus();
  const location = useLocation();

  const isApproveRoute = location.pathname.startsWith("/approve/");

  if (loading) {
    return (
      <div className="spinner-center">
        <div className="spinner" />
      </div>
    );
  }

  if (!state.initialized) {
    return <Onboarding onComplete={refresh} />;
  }

  if (state.locked) {
    return <Unlock onUnlock={unlock} />;
  }

  if (isApproveRoute) {
    return (
      <div className="app-container">
        <div className="app-body" style={{ paddingTop: 8 }}>
          <Routes>
            <Route path="/approve/:requestId" element={<Approve />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <Header account={activeAccount} network={state.network} networkStatus={networkStatus} onLock={lock} />
      <ConnectionBanner status={networkStatus} onRetry={retryApi} />
      <div className="app-body">
        <RouteRestorer />
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/send" element={<Send />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/history" element={<History />} />
          <Route path="/tokens" element={<TokenList />} />
          <Route path="/approve/:requestId" element={<Approve />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/add-wallet" element={<Onboarding onComplete={refresh} addMode />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </div>
      <NavBar />
    </div>
  );
}

export default function App() {
  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}
