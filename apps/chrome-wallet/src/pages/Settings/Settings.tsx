import { useState, useEffect, useCallback } from "react";
import { useWallet } from "../../hooks/useWallet";
import { walletStore } from "../../state/wallet-store";
import { invalidateClientCache } from "../../utils/sdk";
import { truncateAddress } from "../../utils/format";
import CopyButton from "../../components/CopyButton";
import type { ConnectedSite, NetworkId } from "../../state/types";

const NETWORKS: { id: NetworkId; label: string }[] = [
  { id: "testnet4", label: "Testnet4" },
  { id: "mainnet", label: "Mainnet" },
];

export default function Settings() {
  const { activeAccount, state, setNetwork, lock } = useWallet();
  const [connectedSites, setConnectedSites] = useState<Record<string, ConnectedSite>>({});
  const [showReset, setShowReset] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState(state.apiBaseUrl || "http://localhost:3005");
  const [apiKey, setApiKey] = useState(state.apiKey || "");
  const [apiSaved, setApiSaved] = useState(false);

  useEffect(() => {
    setConnectedSites(state.connectedSites);
  }, [state.connectedSites]);

  useEffect(() => {
    setApiBaseUrl(state.apiBaseUrl || "http://localhost:3005");
    setApiKey(state.apiKey || "");
  }, [state.apiBaseUrl, state.apiKey]);

  const handleSaveApiConfig = useCallback(async () => {
    await walletStore.setApiConfig(apiBaseUrl, apiKey);
    invalidateClientCache();
    setApiSaved(true);
    setTimeout(() => setApiSaved(false), 2000);
  }, [apiBaseUrl, apiKey]);

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
        <div className="section-title">API Configuration</div>
        <div className="card">
          <div style={{ marginBottom: 8 }}>
            <label className="input-label" style={{ display: "block", marginBottom: 4 }}>
              API Base URL
            </label>
            <input
              className="input"
              type="text"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="http://localhost:3005"
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
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your API key"
              style={{ width: "100%", boxSizing: "border-box" }}
            />
          </div>
          <button
            className={`btn btn-sm ${apiSaved ? "btn-primary" : "btn-secondary"}`}
            onClick={handleSaveApiConfig}
            style={{ width: "100%" }}
          >
            {apiSaved ? "✓ Saved" : "Save API Settings"}
          </button>
        </div>
      </div>

      {activeAccount && (
        <div className="section">
          <div className="section-title">Wallet</div>
          <div className="card">
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Label</div>
              <div style={{ fontWeight: 600 }}>{activeAccount.label}</div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div className="input-label">Bitcoin Address</div>
              <div className="address-chip" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
                  {activeAccount.btcAddress}
                </span>
                <CopyButton text={activeAccount.btcAddress} />
              </div>
            </div>
            <div>
              <div className="input-label">Public Key</div>
              <div className="address-chip" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span className="mono" style={{ wordBreak: "break-all", fontSize: 11 }}>
                  {truncateAddress(activeAccount.publicKeyHex, 12)}
                </span>
                <CopyButton text={activeAccount.publicKeyHex} />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-title">Connected Sites ({siteEntries.length})</div>
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
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{site.name || origin}</div>
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
        <div className="section-title">Security</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button className="btn btn-secondary btn-full" onClick={lock}>
            🔒 Lock Wallet
          </button>
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
                This will erase all wallet data from this extension. You can re-import using your passkey.
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
        Arch Wallet v0.1.0 &middot; Powered by Wallet Hub
      </div>
    </>
  );
}
