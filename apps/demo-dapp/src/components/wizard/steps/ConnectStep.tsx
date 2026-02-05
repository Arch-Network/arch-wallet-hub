import { useState, useEffect } from "react";
// @ts-ignore - sats-connect types
import { getAddress, AddressPurpose } from "sats-connect";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { WalletState, WalletType } from "../WizardFlow";

interface ConnectStepProps {
  wallet: WalletState | null;
  onWalletConnected: (wallet: WalletState) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  apiKey: string;
  baseUrl: string;
  onApiConfigChange: (baseUrl: string, apiKey: string) => void;
  externalUserId: string;
  client: WalletHubClient;
}

// Type declarations for wallet browser extensions
declare global {
  interface Window {
    unisat?: {
      requestAccounts(): Promise<string[]>;
      getAccounts(): Promise<string[]>;
      getPublicKey(): Promise<string>;
      signPsbt(psbtHex: string, options?: { autoFinalized?: boolean }): Promise<string>;
    };
  }
}

const NETWORKS = ["Testnet4", "Testnet", "Mainnet"];

export default function ConnectStep({
  wallet,
  onWalletConnected,
  isLoading,
  setIsLoading,
  setError,
  apiKey,
  baseUrl,
  onApiConfigChange,
  externalUserId,
  client,
}: ConnectStepProps) {
  const [selectedNetwork, setSelectedNetwork] = useState("Testnet4");
  const [showConfig, setShowConfig] = useState(false);
  const [localBaseUrl, setLocalBaseUrl] = useState(baseUrl);
  const [localApiKey, setLocalApiKey] = useState(apiKey);
  const [connectingWallet, setConnectingWallet] = useState<WalletType>(null);
  
  // Turnkey state
  const [showTurnkeyPanel, setShowTurnkeyPanel] = useState(false);
  const [turnkeyWallets, setTurnkeyWallets] = useState<any[]>([]);
  const [turnkeyLoading, setTurnkeyLoading] = useState(false);
  const [turnkeyResourceId, setTurnkeyResourceId] = useState("");
  const [showCreateWallet, setShowCreateWallet] = useState(false);
  const [newWalletName, setNewWalletName] = useState("");
  const [creatingWallet, setCreatingWallet] = useState(false);

  // Load Turnkey wallets when panel opens
  useEffect(() => {
    if (showTurnkeyPanel && apiKey) {
      loadTurnkeyWallets();
    }
  }, [showTurnkeyPanel, apiKey, externalUserId]);

  const loadTurnkeyWallets = async () => {
    setTurnkeyLoading(true);
    try {
      const res = await client.listTurnkeyWallets(externalUserId);
      setTurnkeyWallets((res as any)?.wallets ?? []);
    } catch (e: any) {
      console.error("Failed to load Turnkey wallets:", e);
      setTurnkeyWallets([]);
    } finally {
      setTurnkeyLoading(false);
    }
  };

  const connectXverse = async () => {
    setConnectingWallet("xverse");
    setIsLoading(true);
    setError(null);

    try {
      const response: any = await new Promise((resolve, reject) => {
        getAddress({
          payload: {
            purposes: [AddressPurpose.Payment, AddressPurpose.Ordinals],
            message: "Connect to Arch Wallet Hub Demo",
            network: { type: selectedNetwork as any },
          },
          onFinish: (res: any) => resolve(res),
          onCancel: () => reject(new Error("User cancelled connection")),
        });
      });

      const taprootAddr = response.addresses?.find(
        (a: any) => a.purpose === "ordinals" || a.address?.startsWith("tb1p") || a.address?.startsWith("bc1p")
      );

      if (!taprootAddr?.address) {
        throw new Error("No Taproot address found in Xverse response");
      }

      onWalletConnected({
        type: "xverse",
        address: taprootAddr.address,
        publicKey: taprootAddr.publicKey || null,
        network: selectedNetwork,
      });
    } catch (e: any) {
      setError(e?.message || "Failed to connect Xverse");
    } finally {
      setIsLoading(false);
      setConnectingWallet(null);
    }
  };

  const connectUnisat = async () => {
    setConnectingWallet("unisat");
    setIsLoading(true);
    setError(null);

    try {
      if (!window.unisat) {
        throw new Error("Unisat wallet not detected. Please install the extension.");
      }

      const accounts = await window.unisat.requestAccounts();
      if (!accounts.length) {
        throw new Error("No accounts returned from Unisat");
      }

      const publicKey = await window.unisat.getPublicKey();

      onWalletConnected({
        type: "unisat",
        address: accounts[0],
        publicKey: publicKey || null,
        network: selectedNetwork,
      });
    } catch (e: any) {
      setError(e?.message || "Failed to connect Unisat");
    } finally {
      setIsLoading(false);
      setConnectingWallet(null);
    }
  };

  const selectTurnkeyWallet = async (tkWallet: any) => {
    setConnectingWallet("turnkey");
    setIsLoading(true);
    setError(null);

    try {
      const resourceId = tkWallet.resourceId || tkWallet.id;
      // The API returns defaultAddress, not taprootAddress
      let address = tkWallet.defaultAddress || tkWallet.taprootAddress || tkWallet.address || "";
      let publicKey = tkWallet.defaultPublicKeyHex || tkWallet.publicKey || null;
      let isCustodial = tkWallet.isCustodial;
      let organizationId = tkWallet.organizationId;
      
      // If no address in the list, fetch full wallet details
      if (!address && resourceId) {
        const fullWallet = await client.getTurnkeyWallet({
          resourceId,
          externalUserId,
        });
        address = (fullWallet as any)?.defaultAddress || (fullWallet as any)?.taprootAddress || (fullWallet as any)?.address || "";
        publicKey = (fullWallet as any)?.defaultPublicKeyHex || (fullWallet as any)?.publicKey || null;
        isCustodial = (fullWallet as any)?.isCustodial;
        organizationId = (fullWallet as any)?.organizationId;
      }
      
      if (!address) {
        throw new Error("Turnkey wallet has no address. It may not have been fully initialized.");
      }

      onWalletConnected({
        type: "turnkey",
        address,
        publicKey,
        network: selectedNetwork,
        turnkeyResourceId: resourceId,
        isCustodial: isCustodial ?? false,
        organizationId,
      });
      setShowTurnkeyPanel(false);
    } catch (e: any) {
      setError(e?.message || "Failed to select Turnkey wallet");
    } finally {
      setIsLoading(false);
      setConnectingWallet(null);
    }
  };

  const connectWithResourceId = async () => {
    if (!turnkeyResourceId.trim()) {
      setError("Please enter a Turnkey Resource ID");
      return;
    }

    setConnectingWallet("turnkey");
    setIsLoading(true);
    setError(null);

    try {
      const tkWallet = await client.getTurnkeyWallet({
        resourceId: turnkeyResourceId.trim(),
        externalUserId,
      });
      
      const address = (tkWallet as any)?.defaultAddress || (tkWallet as any)?.taprootAddress || (tkWallet as any)?.address || "";
      if (!address) {
        throw new Error("Turnkey wallet has no address");
      }

      onWalletConnected({
        type: "turnkey",
        address,
        publicKey: (tkWallet as any)?.defaultPublicKeyHex || (tkWallet as any)?.publicKey || null,
        network: selectedNetwork,
        turnkeyResourceId: turnkeyResourceId.trim(),
        isCustodial: (tkWallet as any)?.isCustodial ?? false,
        organizationId: (tkWallet as any)?.organizationId,
      });
      setShowTurnkeyPanel(false);
    } catch (e: any) {
      setError(e?.message || "Failed to load Turnkey wallet");
    } finally {
      setIsLoading(false);
      setConnectingWallet(null);
    }
  };

  const createCustodialWallet = async () => {
    if (!newWalletName.trim()) {
      setError("Please enter a wallet name");
      return;
    }

    setCreatingWallet(true);
    setError(null);

    try {
      const idempotencyKey = `create-wallet-${externalUserId}-${Date.now()}`;
      const result = await client.createTurnkeyWallet({
        idempotencyKey,
        body: {
          externalUserId,
          walletName: newWalletName.trim(),
          // Default to taproot testnet format (Turnkey format)
          addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR",
        },
      });

      // Wallet created successfully - reload wallet list and auto-select
      setNewWalletName("");
      setShowCreateWallet(false);
      await loadTurnkeyWallets();

      // Auto-connect to the newly created wallet
      const newWallet = {
        resourceId: result.resourceId,
        defaultAddress: result.defaultAddress,
        defaultPublicKeyHex: result.defaultPublicKeyHex,
        organizationId: result.organizationId,
        walletId: result.walletId,
        isCustodial: true,
        name: newWalletName.trim(),
      };
      await selectTurnkeyWallet(newWallet);
    } catch (e: any) {
      setError(e?.message || "Failed to create wallet");
    } finally {
      setCreatingWallet(false);
    }
  };

  const saveConfig = () => {
    onApiConfigChange(localBaseUrl, localApiKey);
    setShowConfig(false);
  };

  return (
    <div className="step-container">
      <div className="step-header">
        <h1 className="step-title">Connect Your Wallet</h1>
        <p className="step-description">
          Choose a wallet to interact with Arch Network
        </p>
      </div>

      {/* Network Selection */}
      <div className="step-section">
        <label className="step-label">Network</label>
        <div className="network-selector">
          {NETWORKS.map((net) => (
            <button
              key={net}
              className={`network-option ${selectedNetwork === net ? "active" : ""}`}
              onClick={() => setSelectedNetwork(net)}
              type="button"
            >
              {net}
            </button>
          ))}
        </div>
      </div>

      {/* Wallet Options */}
      <div className="step-section">
        <label className="step-label">Select Wallet</label>
        <div className="wallet-grid">
          {/* Turnkey */}
          <button
            className={`wallet-card ${wallet?.type === "turnkey" ? "connected" : ""}`}
            onClick={() => setShowTurnkeyPanel(true)}
            disabled={isLoading}
            type="button"
          >
            <div className="wallet-card-icon turnkey">
              <span>🔐</span>
            </div>
            <div className="wallet-card-info">
              <span className="wallet-card-name">Turnkey</span>
              <span className="wallet-card-desc">Passkey Wallet</span>
            </div>
            {connectingWallet === "turnkey" && isLoading && (
              <span className="spinner small"></span>
            )}
            {wallet?.type === "turnkey" && (
              <span className="wallet-connected-badge">✓</span>
            )}
          </button>

          {/* Xverse */}
          <button
            className={`wallet-card ${wallet?.type === "xverse" ? "connected" : ""}`}
            onClick={connectXverse}
            disabled={isLoading}
            type="button"
          >
            <div className="wallet-card-icon xverse">
              <span>X</span>
            </div>
            <div className="wallet-card-info">
              <span className="wallet-card-name">Xverse</span>
              <span className="wallet-card-desc">Bitcoin & Ordinals</span>
            </div>
            {connectingWallet === "xverse" && isLoading && (
              <span className="spinner small"></span>
            )}
            {wallet?.type === "xverse" && (
              <span className="wallet-connected-badge">✓</span>
            )}
          </button>

          {/* Unisat */}
          <button
            className={`wallet-card ${wallet?.type === "unisat" ? "connected" : ""}`}
            onClick={connectUnisat}
            disabled={isLoading}
            type="button"
          >
            <div className="wallet-card-icon unisat">
              <span>U</span>
            </div>
            <div className="wallet-card-info">
              <span className="wallet-card-name">Unisat</span>
              <span className="wallet-card-desc">Bitcoin Wallet</span>
            </div>
            {connectingWallet === "unisat" && isLoading && (
              <span className="spinner small"></span>
            )}
            {wallet?.type === "unisat" && (
              <span className="wallet-connected-badge">✓</span>
            )}
          </button>
        </div>
      </div>

      {/* Turnkey Panel */}
      {showTurnkeyPanel && (
        <div className="turnkey-panel">
          <div className="turnkey-panel-header">
            <h3>Select Turnkey Wallet</h3>
            <button 
              className="turnkey-panel-close" 
              onClick={() => setShowTurnkeyPanel(false)}
              type="button"
            >
              ✕
            </button>
          </div>

          {/* Existing Wallets */}
          {turnkeyLoading ? (
            <div className="turnkey-loading">
              <span className="spinner"></span>
              <span>Loading wallets...</span>
            </div>
          ) : turnkeyWallets.length > 0 ? (
            <div className="turnkey-wallet-list">
              <label className="step-label">Your Wallets</label>
              {turnkeyWallets.map((tw, i) => {
                const addr = tw.defaultAddress || tw.taprootAddress || tw.address || "";
                const isCustodial = tw.isCustodial === true;
                const orgId = tw.organizationId || "";
                const createdAt = tw.createdAt ? new Date(tw.createdAt).toLocaleDateString() : null;
                return (
                  <button
                    key={tw.resourceId || tw.id || i}
                    className="turnkey-wallet-item"
                    onClick={() => selectTurnkeyWallet(tw)}
                    type="button"
                  >
                    <div className="turnkey-wallet-icon">
                      {isCustodial ? "🏦" : "🔐"}
                    </div>
                    <div className="turnkey-wallet-info">
                      <span className="turnkey-wallet-name">
                        {tw.name || tw.walletName || `Wallet ${i + 1}`}
                      </span>
                      <span className="turnkey-wallet-address mono">
                        {addr ? `${addr.slice(0, 12)}...${addr.slice(-6)}` : "(no address)"}
                      </span>
                      <div className="turnkey-wallet-meta">
                        <span className={`turnkey-wallet-type ${isCustodial ? "custodial" : "passkey"}`}>
                          {isCustodial ? "Custodial" : "Passkey"}
                        </span>
                        {orgId && (
                          <span className="turnkey-wallet-org mono" title={orgId}>
                            Org: {orgId.slice(0, 8)}...
                          </span>
                        )}
                        {createdAt && (
                          <span className="turnkey-wallet-date">
                            {createdAt}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="turnkey-empty">
              <p>No wallets found for this user.</p>
            </div>
          )}

          {/* Create Wallet Section */}
          <div className="turnkey-create-section">
            {!showCreateWallet ? (
              <button
                className="btn-secondary create-wallet-btn"
                onClick={() => setShowCreateWallet(true)}
                type="button"
              >
                + Create New Wallet
              </button>
            ) : (
              <div className="create-wallet-form">
                <label className="step-label">Create Custodial Wallet</label>
                <p className="create-wallet-desc">
                  Create a new Turnkey wallet. The server will manage signing for this wallet.
                </p>
                <div className="create-wallet-input">
                  <input
                    type="text"
                    className="form-input"
                    value={newWalletName}
                    onChange={(e) => setNewWalletName(e.target.value)}
                    placeholder="Wallet name (e.g., My Demo Wallet)"
                    disabled={creatingWallet}
                  />
                </div>
                <div className="create-wallet-actions">
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      setShowCreateWallet(false);
                      setNewWalletName("");
                    }}
                    disabled={creatingWallet}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="btn-primary"
                    onClick={createCustodialWallet}
                    disabled={!newWalletName.trim() || creatingWallet}
                    type="button"
                  >
                    {creatingWallet ? (
                      <>
                        <span className="spinner small"></span>
                        Creating...
                      </>
                    ) : (
                      "Create Wallet"
                    )}
                  </button>
                </div>
              </div>
            )}

          </div>

          {/* Manual Resource ID Input */}
          <div className="turnkey-manual">
            <label className="step-label">Or Enter Resource ID</label>
            <div className="turnkey-manual-input">
              <input
                type="text"
                className="form-input mono"
                value={turnkeyResourceId}
                onChange={(e) => setTurnkeyResourceId(e.target.value)}
                placeholder="Enter Turnkey Resource ID"
              />
              <button
                className="btn-primary"
                onClick={connectWithResourceId}
                disabled={!turnkeyResourceId.trim() || isLoading}
                type="button"
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Connected Wallet Info */}
      {wallet && !showTurnkeyPanel && (
        <div className="connected-info">
          <div className="connected-info-header">
            <span className="connected-info-icon">✓</span>
            <span>Connected via {wallet.type === "turnkey" ? "Turnkey" : wallet.type === "xverse" ? "Xverse" : "Unisat"}</span>
          </div>
          <div className="connected-info-address mono">
            {wallet.address.slice(0, 12)}...{wallet.address.slice(-8)}
          </div>
          {wallet.type === "turnkey" && (
            <div className="connected-info-details">
              <div className="connected-info-detail">
                <span className={`turnkey-wallet-type ${wallet.isCustodial ? "custodial" : "passkey"}`}>
                  {wallet.isCustodial ? "🏦 Custodial" : "🔐 Passkey"}
                </span>
              </div>
              {wallet.organizationId && (
                <div className="connected-info-detail mono" title={wallet.organizationId}>
                  Org: {wallet.organizationId.slice(0, 8)}...{wallet.organizationId.slice(-4)}
                </div>
              )}
              {wallet.turnkeyResourceId && (
                <div className="connected-info-detail mono" title={wallet.turnkeyResourceId}>
                  Resource: {wallet.turnkeyResourceId.slice(0, 8)}...
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* API Config Toggle */}
      <div className="step-footer">
        <button
          className="config-toggle"
          onClick={() => setShowConfig(!showConfig)}
          type="button"
        >
          ⚙️ {showConfig ? "Hide" : "API"} Config
        </button>
      </div>

      {/* API Config Panel */}
      {showConfig && (
        <div className="config-panel">
          <div className="config-field">
            <label>API Endpoint</label>
            <input
              type="text"
              value={localBaseUrl}
              onChange={(e) => setLocalBaseUrl(e.target.value)}
              placeholder="http://localhost:3005/v1"
            />
          </div>
          <div className="config-field">
            <label>API Key</label>
            <input
              type="password"
              value={localApiKey}
              onChange={(e) => setLocalApiKey(e.target.value)}
              placeholder="Enter API key"
            />
          </div>
          <button className="btn-secondary" onClick={saveConfig} type="button">
            Save Config
          </button>
        </div>
      )}
    </div>
  );
}
