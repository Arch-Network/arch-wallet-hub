import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { useWallet } from "../../src/hooks/useWallet";
import Header from "../../src/components/Header";
import NavBar from "../../src/components/NavBar";
import Onboarding from "../../src/pages/Onboarding/Onboarding";
import Unlock from "../../src/pages/Unlock/Unlock";
import Dashboard from "../../src/pages/Dashboard/Dashboard";
import Send from "../../src/pages/Send/Send";
import Receive from "../../src/pages/Receive/Receive";
import History from "../../src/pages/History/History";
import TokenList from "../../src/pages/TokenList/TokenList";
import Approve from "../../src/pages/Approve/Approve";
import Settings from "../../src/pages/Settings/Settings";

function AppRoutes() {
  const { state, activeAccount, loading, lock, unlock, refresh } = useWallet();

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

  return (
    <div className="app-container">
      <Header account={activeAccount} network={state.network} onLock={lock} />
      <div className="app-body">
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/send" element={<Send />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/history" element={<History />} />
          <Route path="/tokens" element={<TokenList />} />
          <Route path="/approve/:requestId" element={<Approve />} />
          <Route path="/settings" element={<Settings />} />
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
