import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "../../hooks/useWallet";
import { walletStore } from "../../state/wallet-store";
import { invalidateClientCache } from "../../utils/sdk";
import { truncateAddress } from "../../utils/format";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";
import CopyButton from "../../components/CopyButton";
import RecoverViaEmailCta from "../../components/RecoverViaEmailCta";
import TestRecoveryEmailButton from "../../components/TestRecoveryEmailButton";
import type { ConnectedSite, NetworkId, WalletAccount } from "../../state/types";
import { DEFAULT_HUB_BASE_URL, isAllowedHubBaseUrl, isExternalAccount } from "../../state/types";
import { INDEXER_BASE_URL } from "../../utils/explorer-config";
import { APP_VERSION } from "../../utils/version";
import DiagnosticsLogView from "../../components/DiagnosticsLogView";
import { isSentryAvailableForOptIn } from "../../utils/log";

const NETWORKS: { id: NetworkId; label: string }[] = [
  { id: "testnet4", label: "Testnet4" },
  { id: "mainnet", label: "Mainnet" },
];

const AUTO_LOCK_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1 minute" },
  { value: 5, label: "5 minutes" },
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
];

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function accountAuthLabel(account: WalletAccount): string {
  if (isExternalAccount(account)) {
    if (account.externalProvider === "unisat") return "UniSat";
    return "Xverse";
  }
  return account.authMethod === "email" ? "Email" : "Passkey";
}

function accountAuthTone(account: WalletAccount): { background: string; color: string } {
  if (isExternalAccount(account)) {
    return { background: "rgba(255,176,32,0.16)", color: "#ffb020" };
  }
  return account.authMethod === "email"
    ? { background: "rgba(123,104,238,0.15)", color: "#7b68ee" }
    : { background: "rgba(46,204,113,0.15)", color: "#2ecc71" };
}

export default function Settings() {
  const navigate = useNavigate();
  const { activeAccount, state, setNetwork, lock, refresh, setAutoLockMinutes } = useWallet();
  const [connectedSites, setConnectedSites] = useState<Record<string, ConnectedSite>>({});
  const [showReset, setShowReset] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [hubBaseUrl, setHubBaseUrl] = useState(state.hubBaseUrl || DEFAULT_HUB_BASE_URL);
  const [hubApiKey, setHubApiKey] = useState(state.hubApiKey || "");
  const [hubSaved, setHubSaved] = useState(false);
  const [hubError, setHubError] = useState<string | null>(null);

  const [indexerBaseUrl, setIndexerBaseUrl] = useState(state.indexerBaseUrl || INDEXER_BASE_URL);
  const [indexerApiKey, setIndexerApiKey] = useState(state.indexerApiKey || "");
  const [indexerSaved, setIndexerSaved] = useState(false);

  const [pwOld, setPwOld] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwSaved, setPwSaved] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const displayBtcAddress = useMemo(
    () => activeAccount ? reEncodeTaprootAddress(activeAccount.btcAddress, state.network) : "",
    [activeAccount, state.network]
  );

  useEffect(() => {
    setConnectedSites(state.connectedSites);
  }, [state.connectedSites]);

  useEffect(() => {
    setHubBaseUrl(state.hubBaseUrl || DEFAULT_HUB_BASE_URL);
    setHubApiKey(state.hubApiKey || "");
  }, [state.hubBaseUrl, state.hubApiKey]);

  useEffect(() => {
    setIndexerBaseUrl(state.indexerBaseUrl || INDEXER_BASE_URL);
    setIndexerApiKey(state.indexerApiKey || "");
  }, [state.indexerBaseUrl, state.indexerApiKey]);

  const handleSaveHubConfig = useCallback(async () => {
    setHubError(null);
    const trimmed = hubBaseUrl.trim();
    if (state.network === "mainnet" && !isHttpsUrl(trimmed)) {
      setHubError("Mainnet requires an HTTPS Hub URL");
      return;
    }
    if (!isAllowedHubBaseUrl(trimmed)) {
      setHubError(
        "Hub URL not allowed. Use hub.arch.network or a vetted *.arch.network host.",
      );
      return;
    }
    try {
      await walletStore.setHubConfig(trimmed, hubApiKey.trim());
    } catch (err: any) {
      setHubError(err?.message || "Failed to save Hub config");
      return;
    }
    invalidateClientCache();
    setHubSaved(true);
    setTimeout(() => setHubSaved(false), 2000);
  }, [hubBaseUrl, hubApiKey, state.network]);

  const handleSaveIndexerConfig = useCallback(async () => {
    await walletStore.setIndexerConfig(indexerBaseUrl.trim(), indexerApiKey.trim());
    invalidateClientCache();
    setIndexerSaved(true);
    setTimeout(() => setIndexerSaved(false), 2000);
  }, [indexerBaseUrl, indexerApiKey]);

  const handleDisconnect = useCallback(async (origin: string) => {
    await walletStore.disconnectSite(origin);
    setConnectedSites((prev) => {
      const next = { ...prev };
      delete next[origin];
      return next;
    });
  }, []);

  const handleReset = useCallback(async () => {
    await walletStore.reset();
    window.location.reload();
  }, []);

  const handleSwitchWallet = useCallback(async (accountId: string) => {
    await walletStore.setActiveAccount(accountId);
    await refresh();
  }, [refresh]);

  /**
   * Disconnect a linked external wallet.
   *
   * "Disconnect" = remove the link from Arch Wallet's local state only.
   * The user's Xverse / UniSat wallet (and the funds inside it) is
   * untouched -- we never held its keys to begin with. The Hub-side
   * link record persists too; the user can re-link the same address
   * later and get the same `linkedWalletId` back.
   *
   * Last-wallet edge case: if this is the only wallet on the device,
   * `walletStore.forgetAccount` wipes the keystore and routes the next
   * mount back to Onboarding. Surface that in the confirm copy so the
   * user isn't surprised by the reset.
   */
  const handleDisconnectWallet = useCallback(
    async (account: WalletAccount) => {
      const providerLabel = accountAuthLabel(account);
      const isLast = state.accounts.length === 1;
      const message = isLast
        ? `Disconnect "${account.label}" (${providerLabel})?\n\n` +
          `This is your only wallet, so Arch Wallet will reset to onboarding on this device.\n\n` +
          `Your ${providerLabel} wallet itself is unaffected — you can re-link it anytime.`
        : `Disconnect "${account.label}" (${providerLabel})?\n\n` +
          `This only removes the link from Arch Wallet on this device. ` +
          `Your ${providerLabel} wallet (and its funds) is unaffected — you can re-link it anytime.`;
      if (!window.confirm(message)) return;
      await walletStore.forgetAccount(account.id);
      await refresh();
    },
    [refresh, state.accounts.length],
  );

  const handleChangePassword = useCallback(async () => {
    setPwError(null);
    setPwSaved(false);
    if (pwNew.length < 8) {
      setPwError("New password must be at least 8 characters");
      return;
    }
    if (pwNew !== pwConfirm) {
      setPwError("Passwords do not match");
      return;
    }
    try {
      await walletStore.changePassword(pwOld, pwNew);
      setPwSaved(true);
      setPwOld("");
      setPwNew("");
      setPwConfirm("");
      setTimeout(() => setPwSaved(false), 2000);
    } catch (e: any) {
      setPwError(e?.name === "WrongPasswordError" ? "Current password is incorrect" : e?.message || "Failed to change password");
    }
  }, [pwOld, pwNew, pwConfirm]);

  const siteEntries = Object.entries(connectedSites);

  return (
    <>
      <div className="section">
        <div className="section-title">Network</div>
        <div className="card">
          <div style={{ display: "flex", gap: 8 }}>
            {NETWORKS.map((n) => (
              <button
                key={n.id}
                className={`btn btn-sm ${state.network === n.id ? "btn-primary" : "btn-secondary"}`}
                onClick={() => setNetwork(n.id)}
                style={{ flex: 1 }}
              >
                {n.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Security</div>
        <div className="card">
          <div style={{ marginBottom: 12 }}>
            <div className="input-label" style={{ marginBottom: 4 }}>Auto-lock</div>
            <select
              className="input"
              value={state.autoLockMinutes ?? 15}
              onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
              style={{ width: "100%", boxSizing: "border-box" }}
            >
              {AUTO_LOCK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
              Locks the wallet after this much inactivity.
            </div>
          </div>

          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Change password</summary>
            <div style={{ marginTop: 8 }}>
              {pwError && <div className="error-banner" style={{ marginBottom: 8 }}>{pwError}</div>}
              {pwSaved && (
                <div style={{ marginBottom: 8, color: "var(--success)", fontSize: 12 }}>Password changed</div>
              )}
              <input
                className="input"
                type="password"
                placeholder="Current password"
                value={pwOld}
                onChange={(e) => setPwOld(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", marginBottom: 6 }}
              />
              <input
                className="input"
                type="password"
                placeholder="New password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", marginBottom: 6 }}
              />
              <input
                className="input"
                type="password"
                placeholder="Confirm new password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", marginBottom: 6 }}
              />
              <button className="btn btn-sm btn-primary" onClick={handleChangePassword}>
                Update password
              </button>
            </div>
          </details>

          <button className="btn btn-secondary btn-full" onClick={lock} style={{ marginBottom: 8 }}>
            Lock wallet
          </button>
          {/* Same OTP flow services both wallet types now -- passkey
              wallets get a fresh authenticator, email wallets get a
              fresh IndexedDB session. The button is hidden only when
              there's no active account (e.g. mid-migration).

              We pin to the active account so the Hub returns only
              this wallet's candidates, skipping the wallet-picker
              step when there's a single match. */}
          {activeAccount && !isExternalAccount(activeAccount) && (
            <>
              <RecoverViaEmailCta
                pinToActiveAccount
                resourceId={activeAccount.turnkeyResourceId}
                label={
                  activeAccount.authMethod === "passkey"
                    ? "Add or replace passkey"
                    : "Re-verify email signing"
                }
                title={
                  activeAccount.authMethod === "passkey"
                    ? "Use email recovery to attach a new passkey to this wallet"
                    : "Re-bootstrap this email wallet's signing session via OTP"
                }
              />
              {/* Deliverability probe -- lives next to the recovery
                  CTA so users naturally test it while they're already
                  thinking about recovery. The button is its own
                  component because the status-row state machine is
                  big enough to warrant separation. */}
              <TestRecoveryEmailButton email={activeAccount.recoveryEmail} />
            </>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-title">Open Wallet As</div>
        <div className="card">
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className={`btn btn-sm ${state.openAs === "popup" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => walletStore.setOpenAs("popup")}
              style={{ flex: 1 }}
            >
              Popup
            </button>
            <button
              className={`btn btn-sm ${state.openAs === "sidepanel" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => walletStore.setOpenAs("sidepanel")}
              style={{ flex: 1 }}
            >
              Side Panel
            </button>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "8px 0 0" }}>
            Popup closes when you click away. Side panel stays open while you browse.
          </p>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Wallets ({state.accounts.length})</div>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          {state.accounts.map((acct: WalletAccount) => {
            const isActive = acct.id === state.activeAccountId;
            const badgeTone = accountAuthTone(acct);
            // Only external (Xverse / UniSat) wallets get the disconnect
            // affordance: those are pure links to user-owned wallets we
            // never held keys for, so "disconnect" is a clean operation.
            // Removing passkey/email wallets is a much riskier action
            // (only doable via the existing Reset flow) and intentionally
            // not exposed inline here.
            const canDisconnect = isExternalAccount(acct);
            return (
              <div
                key={acct.id}
                style={{
                  display: "flex",
                  alignItems: "stretch",
                  borderBottom: "1px solid var(--border-primary)",
                  background: isActive ? "rgba(193,154,91,0.08)" : "transparent",
                }}
              >
                <button
                  onClick={() => handleSwitchWallet(acct.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flex: 1,
                    minWidth: 0,
                    padding: "10px 12px",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    textAlign: "left",
                    color: "inherit",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: isActive ? "var(--success)" : "var(--border-primary)",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                      {acct.label}
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          padding: "1px 5px",
                          borderRadius: 4,
                          background: badgeTone.background,
                          color: badgeTone.color,
                          letterSpacing: 0.5,
                          textTransform: "uppercase",
                        }}
                      >
                        {accountAuthLabel(acct)}
                      </span>
                    </div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {truncateAddress(acct.btcAddress, 10)}
                    </div>
                  </div>
                  {isActive && (
                    <span style={{ fontSize: 10, color: "var(--accent)", fontWeight: 700 }}>Active</span>
                  )}
                </button>
                {canDisconnect && (
                  <button
                    onClick={() => handleDisconnectWallet(acct)}
                    title={`Disconnect ${acct.label}`}
                    aria-label={`Disconnect ${acct.label}`}
                    style={{
                      padding: "0 12px",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      color: "var(--text-muted)",
                      fontSize: 18,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <button
            onClick={() => navigate("/add-wallet")}
            style={{
              display: "block",
              width: "100%",
              padding: "10px 12px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--accent)",
              fontWeight: 600,
              fontSize: 13,
              textAlign: "center",
            }}
          >
            + Add Wallet
          </button>
          <button
            onClick={() => navigate("/add-watch")}
            style={{
              display: "block",
              width: "100%",
              padding: "6px 12px 10px",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--text-muted)",
              fontWeight: 500,
              fontSize: 12,
              textAlign: "center",
            }}
          >
            + Add Watch-Only Address
          </button>
        </div>
      </div>

      {activeAccount && (
        <div className="section">
          <div className="section-title">Active Wallet Details</div>
          <div className="card">
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Label</div>
              <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                {activeAccount.label}
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    padding: "1px 5px",
                    borderRadius: 4,
                    background: accountAuthTone(activeAccount).background,
                    color: accountAuthTone(activeAccount).color,
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                  }}
                >
                  {accountAuthLabel(activeAccount)}
                </span>
              </div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Bitcoin Address</div>
              <div className="address-chip address-chip-wrap">
                <span className="mono address-chip-value" style={{ fontSize: 11 }}>
                  {displayBtcAddress}
                </span>
                <CopyButton text={displayBtcAddress} />
              </div>
            </div>
            <div>
              <div className="input-label">Public Key</div>
              <div className="address-chip address-chip-wrap">
                <span className="mono address-chip-value" style={{ fontSize: 11 }}>
                  {truncateAddress(activeAccount.publicKeyHex, 12)}
                </span>
                <CopyButton text={activeAccount.publicKeyHex} />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">Contacts ({state.contacts?.length ?? 0})</div>
        {(!state.contacts || state.contacts.length === 0) ? (
          <div className="card">
            <div style={{ color: "var(--text-muted)", fontSize: 12, textAlign: "center", padding: 8 }}>
              No saved contacts yet
            </div>
          </div>
        ) : (
          <div className="card">
            {state.contacts.map((c) => (
              <div key={`${c.address}-${c.network}-${c.mint || ""}`} className="contact-card">
                <div className="contact-avatar">{c.label.slice(0, 2).toUpperCase()}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="contact-name">{c.label}</div>
                  <div className="contact-addr mono">{truncateAddress(c.address, 10)}</div>
                </div>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() =>
                    walletStore.removeContact({ address: c.address, network: c.network, mint: c.mint }).then(refresh)
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-title">
          Connected Sites ({siteEntries.length})
          <span style={{ marginLeft: 6, fontSize: 10, color: "var(--text-muted)", fontWeight: 400 }}>
            (your dapp bookmarks)
          </span>
        </div>
        {siteEntries.length === 0 ? (
          <div className="card">
            <div style={{ color: "var(--text-muted)", fontSize: 12, textAlign: "center", padding: 8 }}>
              No connected sites
            </div>
          </div>
        ) : (
          <div className="card">
            {siteEntries.map(([origin, site]) => (
              <div key={origin} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border-primary)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a
                    href={origin}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 13, fontWeight: 500, color: "var(--accent)", textDecoration: "none" }}
                  >
                    {site.name || origin} {"\u2197"}
                  </a>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{origin}</div>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => handleDisconnect(origin)}>
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: 12,
            textDecoration: "underline",
          }}
        >
          {showAdvanced ? "Hide advanced settings" : "Show advanced settings"}
        </button>
      </div>

      {showAdvanced && (
        <>
          <div className="section">
            <div className="section-title">Indexer API</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
              Reads, faucet, BTC, and Arch RPC compat.
            </div>
            <div className="card">
              <div style={{ marginBottom: 8 }}>
                <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
                  Base URL
                </label>
                <input
                  className="input"
                  type="text"
                  value={indexerBaseUrl}
                  onChange={(e) => setIndexerBaseUrl(e.target.value)}
                  placeholder={INDEXER_BASE_URL}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>
              <div style={{ marginBottom: 10 }}>
                <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
                  API Key
                </label>
                <input
                  className="input"
                  type="password"
                  value={indexerApiKey}
                  onChange={(e) => setIndexerApiKey(e.target.value)}
                  placeholder="arch_live_..."
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>
              <button
                className={`btn btn-sm ${indexerSaved ? "btn-primary" : "btn-secondary"}`}
                onClick={handleSaveIndexerConfig}
                style={{ width: "100%" }}
              >
                {indexerSaved ? "Saved" : "Save Indexer Settings"}
              </button>
            </div>
          </div>

          <div className="section">
            <div className="section-title">Wallet Hub API</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
              Turnkey, signing requests, custodial BTC sends, recovery.
            </div>
            <div className="card">
              {hubError && <div className="error-banner" style={{ marginBottom: 8 }}>{hubError}</div>}
              <div style={{ marginBottom: 8 }}>
                <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
                  Base URL
                </label>
                <input
                  className="input"
                  type="text"
                  value={hubBaseUrl}
                  onChange={(e) => setHubBaseUrl(e.target.value)}
                  placeholder={DEFAULT_HUB_BASE_URL}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
                {state.network === "mainnet" && !isHttpsUrl(hubBaseUrl) && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--danger)" }}>
                    Mainnet requires HTTPS.
                  </div>
                )}
                {hubBaseUrl.trim() !== "" && !isAllowedHubBaseUrl(hubBaseUrl.trim()) && (
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--danger)" }}>
                    Host not in allowlist. Use hub.arch.network or a *.arch.network host.
                  </div>
                )}
              </div>
              <div style={{ marginBottom: 10 }}>
                <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
                  API Key
                </label>
                <input
                  className="input"
                  type="password"
                  value={hubApiKey}
                  onChange={(e) => setHubApiKey(e.target.value)}
                  placeholder="Enter your Hub API key"
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>
              <button
                className={`btn btn-sm ${hubSaved ? "btn-primary" : "btn-secondary"}`}
                onClick={handleSaveHubConfig}
                style={{ width: "100%" }}
              >
                {hubSaved ? "Saved" : "Save Hub Settings"}
              </button>
            </div>
          </div>

          <div className="section">
            <div className="section-title">Diagnostics</div>
            <div className="card">
              {isSentryAvailableForOptIn() ? (
                <>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={state.sentryOptIn ?? false}
                      onChange={(e) => walletStore.setSentryOptIn(e.target.checked)}
                    />
                    <span style={{ fontSize: 13 }}>Send anonymous error reports</span>
                  </label>
                  <p style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
                    Off by default. We never collect addresses, keys, or transaction contents.
                  </p>
                </>
              ) : null}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: isSentryAvailableForOptIn() ? 12 : 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={state.debugMode ?? false}
                  onChange={(e) => walletStore.setDebugMode(e.target.checked)}
                />
                <span style={{ fontSize: 13 }}>Debug mode (verbose logs)</span>
              </label>
              {state.debugMode ? (
                <div style={{ marginTop: 12 }}>
                  <DiagnosticsLogView />
                </div>
              ) : null}
            </div>
          </div>
        </>
      )}

      <div className="section">
        <div className="section-title">Danger zone</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {!showReset ? (
            <button
              className="btn btn-secondary btn-full"
              style={{ color: "var(--danger)" }}
              onClick={() => setShowReset(true)}
            >
              Reset Wallet
            </button>
          ) : (
            <div className="card" style={{ borderColor: "var(--danger)" }}>
              <p style={{ fontSize: 12, marginBottom: 8, color: "var(--danger)" }}>
                This erases the encrypted keystore and all local data from this extension.
                Make sure your recovery email/passkey access is working before resetting.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-sm btn-secondary" style={{ flex: 1 }} onClick={() => setShowReset(false)}>
                  Cancel
                </button>
                <button className="btn btn-sm btn-danger" style={{ flex: 1 }} onClick={handleReset}>
                  Confirm Reset
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ textAlign: "center", padding: "16px 0", color: "var(--text-muted)", fontSize: 11 }}>
        Arch Wallet v{APP_VERSION} &middot; Powered by Wallet Hub
      </div>
    </>
  );
}
