import { useEffect, useRef, useState } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useWallet } from "../../src/hooks/useWallet";
import { walletStore } from "../../src/state/wallet-store";
import {
  applyDiagnosticsRuntime,
  installGlobalErrorHandlers,
} from "../../src/utils/log";
import Header from "../../src/components/Header";
import ConnectionBanner from "../../src/components/ConnectionBanner";
import NavBar from "../../src/components/NavBar";
import SideNav from "../../src/components/SideNav";
import { useApiStatus } from "../../src/hooks/useApiStatus";
import Onboarding from "../../src/pages/Onboarding/Onboarding";
import Unlock from "../../src/pages/Unlock/Unlock";
import Dashboard from "../../src/pages/Dashboard/Dashboard";
import Send from "../../src/pages/Send/Send";
import Receive from "../../src/pages/Receive/Receive";
import History from "../../src/pages/History/History";
import TokenList from "../../src/pages/TokenList/TokenList";
import TokenDetail from "../../src/pages/TokenDetail/TokenDetail";
import Approve from "../../src/pages/Approve/Approve";
import Settings from "../../src/pages/Settings/Settings";
import Recover from "../../src/pages/Recover/Recover";
import Swap from "../../src/pages/Swap/Swap";
import { hasActiveRecoveryCheckpoint } from "../../src/state/recovery-session";
import { isInSidePanel } from "../../src/utils/runtime-context";

const ROUTE_STORAGE_KEY = "arch_wallet_last_route";
const SIDE_PANEL_NOTICE_DISMISSED_KEY = "arch_wallet_sidepanel_default_notice_dismissed";
const VALID_ROUTES = [
  "/dashboard",
  "/send",
  "/receive",
  "/history",
  "/tokens",
  "/swap",
  "/settings",
];

function RouteRestorer() {
  const location = useLocation();
  const navigate = useNavigate();
  const restored = useRef(false);

  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    if (location.pathname.startsWith("/approve/")) return;
    if (location.pathname.startsWith("/recover")) return;
    // The side-panel → popup swap handoff opens this window with the
    // intent encoded as `?...&resume=1`. If we blindly restore the
    // last-visited route here we'd nuke those params and the popup
    // would land on /dashboard with nothing to sign. Respect explicit
    // navigation whenever the URL is carrying state.
    if (
      location.search.includes("resume=1") ||
      location.search.includes("resumeOnboarding=")
    ) {
      return;
    }

    // Recovery checkpoint takes priority over the saved last-route:
    // if the user is in the middle of OTP verification and stepped
    // away to read their email, we want the popup to land back on
    // /recover (not /dashboard) when they reopen it. The checkpoint
    // is short-lived (10 min TTL) so this won't strand users who
    // simply abandoned recovery a while ago.
    hasActiveRecoveryCheckpoint().then((hasCheckpoint) => {
      if (hasCheckpoint) {
        // Preserve any pinnedExternalUserId we encoded in the
        // checkpoint by reading it inline -- the Recover screen
        // re-reads the checkpoint on mount and reconstructs state.
        navigate("/recover", { replace: true });
        return;
      }
      chrome.storage.local.get(ROUTE_STORAGE_KEY).then((result) => {
        const saved = result[ROUTE_STORAGE_KEY];
        if (saved && VALID_ROUTES.includes(saved) && saved !== location.pathname) {
          navigate(saved, { replace: true });
        }
      });
    });
  }, []);

  useEffect(() => {
    if (VALID_ROUTES.includes(location.pathname)) {
      chrome.storage.local.set({ [ROUTE_STORAGE_KEY]: location.pathname });
    }
  }, [location.pathname]);

  return null;
}

/**
 * Notifies the background of UI activity so it can reset the
 * auto-lock idle timer. We only need to fire on navigation; the
 * background's chrome.idle listener handles passive user presence.
 */
function ActivityPinger() {
  const location = useLocation();
  useEffect(() => {
    try {
      chrome.runtime?.sendMessage?.({ type: "USER_ACTIVE" });
    } catch {
      /* ignore */
    }
  }, [location.pathname]);
  return null;
}

function SidePanelDefaultNotice({
  openAs,
  onChanged,
}: {
  openAs: "popup" | "sidepanel";
  onChanged: () => Promise<void>;
}) {
  const [dismissed, setDismissed] = useState(true);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!isInSidePanel() || openAs !== "sidepanel") return;
    setDismissed(localStorage.getItem(SIDE_PANEL_NOTICE_DISMISSED_KEY) === "1");
  }, [openAs]);

  if (!isInSidePanel() || openAs !== "sidepanel" || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(SIDE_PANEL_NOTICE_DISMISSED_KEY, "1");
    setDismissed(true);
  };

  const switchToPopup = async () => {
    setSwitching(true);
    try {
      await walletStore.setOpenAs("popup");
      dismiss();
      await onChanged();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="sidepanel-default-toast" role="status">
      <div className="sidepanel-default-toast-icon" aria-hidden="true">
        i
      </div>
      <div className="sidepanel-default-toast-copy">
        Arch Wallet now opens in the side panel by default.{" "}
        <button type="button" onClick={switchToPopup} disabled={switching}>
          Switch back to popup
        </button>{" "}
        any time from the menu.
      </div>
      <button
        type="button"
        className="sidepanel-default-toast-close"
        aria-label="Dismiss"
        onClick={dismiss}
      >
        ×
      </button>
    </div>
  );
}

/** Per-route layout class -- caps form/settings widths in wide side panel. */
function bodyClassForPath(pathname: string): string {
  if (pathname === "/send") return "app-body app-body-wide";
  if (pathname === "/receive") return "app-body app-body-narrow";
  if (pathname.startsWith("/tokens/")) return "app-body app-body-wide";
  if (pathname === "/swap") return "app-body app-body-medium";
  if (pathname === "/settings" || pathname === "/add-wallet" || pathname === "/tokens") {
    return "app-body app-body-medium";
  }
  if (pathname === "/dashboard" || pathname === "/") return "app-body app-body-full";
  return "app-body";
}

function AppRoutes() {
  const { state, migration, activeAccount, loading, lock, unlock, refresh, setNetwork, sealLegacy } = useWallet();

  // Diagnostics sync: mirror the persisted toggles into the runtime
  // log module whenever they change. Effect captures the wallet
  // state from the same hook the rest of the shell uses, so we
  // don't double-poll storage.
  useEffect(() => {
    applyDiagnosticsRuntime({
      debugMode: !!state.debugMode,
      sentryOptIn: !!state.sentryOptIn,
    });
  }, [state.debugMode, state.sentryOptIn]);

  // Defer probing until the wallet is unlocked. Probing earlier reads the
  // locked-shell state (empty indexerApiKey), which causes the auth-gated
  // BTC fee-estimates endpoint to 401 and pin a spurious
  // "Bitcoin data unavailable" banner until the next 30s tick / Retry.
  const apiStatusEnabled = state.initialized && !state.locked;
  const { status: networkStatus, retry: retryApi } = useApiStatus({ enabled: apiStatusEnabled });
  const location = useLocation();

  const isApproveRoute = location.pathname.startsWith("/approve/");
  const isRecoverRoute = location.pathname.startsWith("/recover");
  const showHubWarning =
    location.pathname === "/settings" ||
    location.pathname === "/add-wallet";

  const bodyClass = bodyClassForPath(location.pathname);

  if (loading) {
    return (
      <div className="spinner-center">
        <div className="spinner" />
      </div>
    );
  }

  // Recovery flow is always reachable, even when locked or fresh.
  if (isRecoverRoute) {
    return (
      <div className="app-container">
        <div className="app-body">
          <Routes>
            <Route path="/recover" element={<Recover onRecovered={refresh} />} />
            <Route path="*" element={<Navigate to="/recover" replace />} />
          </Routes>
        </div>
      </div>
    );
  }

  // Legacy plaintext blob exists -- nudge the user to set a password
  // before we let them do anything else. This is a one-shot screen.
  if (migration.kind === "needs_password") {
    return <Onboarding onComplete={refresh} secureLegacyState={migration.legacyState} />;
  }

  if (!state.initialized) {
    return <Onboarding onComplete={refresh} />;
  }

  if (state.locked) {
    return <Unlock onUnlock={unlock} />;
  }

  // Defensive: if the keystore is initialized + unlocked but the
  // accounts array is empty (e.g. a forget-last-wallet path failed
  // to flip `initialized` to false), routing the user to the main
  // dashboard would render a broken shell. Bounce them to
  // Onboarding so they always have a path forward.
  if (state.accounts.length === 0) {
    return <Onboarding onComplete={refresh} />;
  }

  // Important UX boundary: password unlock opens the wallet. Email
  // OTP is only a signing-session bootstrap for email-auth wallets,
  // not a general app unlock requirement. The previous app-wide
  // SessionBootstrapper gate made read-only wallet access depend on
  // email delivery + Turnkey OTP_AUTH, which stranded users on
  // "Verify by email" even when they only wanted dashboard/history.
  // Signing-sensitive flows should request/open a session at the
  // point of signing instead of blocking the whole shell here.

  if (isApproveRoute) {
    return (
      <div className="app-container" data-network={state.network}>
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
    <div className="app-container" data-network={state.network}>
      <SideNav network={state.network} />
      <div className="app-main">
        <SidePanelDefaultNotice openAs={state.openAs} onChanged={refresh} />
        <Header account={activeAccount} network={state.network} networkStatus={networkStatus} onLock={lock} onNetworkChange={setNetwork} />
        <ConnectionBanner status={networkStatus} onRetry={retryApi} showHubWarning={showHubWarning} />
        <div className={bodyClass}>
          <RouteRestorer />
          <ActivityPinger />
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/send" element={<Send networkStatus={networkStatus} />} />
            <Route path="/receive" element={<Receive />} />
            <Route path="/history" element={<History />} />
            <Route path="/tokens" element={<TokenList />} />
            <Route path="/tokens/:mint" element={<TokenDetail />} />
            <Route path="/swap" element={<Swap />} />
            <Route path="/approve/:requestId" element={<Approve />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/add-wallet" element={<Onboarding onComplete={refresh} addMode />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </div>
        <NavBar />
      </div>
    </div>
  );
}

export default function App() {
  // Install global error/unhandled-rejection listeners once per popup
  // realm so uncaught throws reach `log.error` (and Sentry, when opted
  // in). Done in `App` rather than `AppRoutes` so the listeners don't
  // re-install across route transitions.
  useEffect(() => {
    const teardown = installGlobalErrorHandlers(window);
    return teardown;
  }, []);

  return (
    <HashRouter>
      <AppRoutes />
    </HashRouter>
  );
}
