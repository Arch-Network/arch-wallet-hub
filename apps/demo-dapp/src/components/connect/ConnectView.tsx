import { useState, useCallback } from "react";
// @ts-ignore - sats-connect types
import { getAddress, AddressPurpose } from "sats-connect";
import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { ConnectedWallet } from "../../types";

declare global {
  interface Window {
    unisat?: {
      requestAccounts(): Promise<string[]>;
      getAccounts(): Promise<string[]>;
      getPublicKey(): Promise<string>;
      signPsbt?(psbtHex: string, options?: { autoFinalized?: boolean }): Promise<string>;
      sendBitcoin?(toAddress: string, satoshis: number): Promise<string>;
      signMessage?(message: string, type?: string): Promise<string>;
    };
  }
}

type ConnectViewProps = {
  client: WalletHubClient;
  externalUserId: string;
  onConnect: (wallet: ConnectedWallet) => void;
};

type TurnkeyWalletEntry = {
  id: string;
  resourceId?: string;
  defaultAddress?: string;
  defaultPublicKeyHex?: string;
  walletId?: string;
  organizationId?: string;
  isCustodial?: boolean;
  name?: string;
  walletName?: string;
  createdAt?: string;
};

export default function ConnectView({
  client,
  externalUserId,
  onConnect,
}: ConnectViewProps) {
  const NETWORKS = ["Testnet4", "Testnet", "Signet", "Mainnet"] as const;
  const [network, setNetwork] = useState<string>(
    () => localStorage.getItem("arch-wallet-hub:network") || "Testnet4"
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnkeyMode, setTurnkeyMode] = useState<
    null | "create" | "existing"
  >(null);
  const [turnkeyWallets, setTurnkeyWallets] = useState<TurnkeyWalletEntry[]>(
    []
  );
  const [turnkeyListLoading, setTurnkeyListLoading] = useState(false);

  const handleNetworkChange = useCallback((n: string) => {
    setNetwork(n);
    localStorage.setItem("arch-wallet-hub:network", n);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const connectXverse = useCallback(async () => {
    setLoading(true);
    clearError();
    try {
      const response: any = await new Promise((resolve, reject) => {
        getAddress({
          payload: {
            purposes: [AddressPurpose.Payment, AddressPurpose.Ordinals],
            message: "Connect to Arch Wallet Hub",
            network: { type: network as any },
          },
          onFinish: (res: any) => resolve(res),
          onCancel: () => reject(new Error("User cancelled connection")),
        });
      });

      const taprootAddr = response.addresses?.find(
        (a: any) =>
          a.purpose === "ordinals" ||
          a.address?.startsWith("tb1p") ||
          a.address?.startsWith("bc1p")
      );

      if (!taprootAddr?.address) {
        throw new Error("No Taproot address found in Xverse response");
      }

      onConnect({
        type: "xverse",
        address: taprootAddr.address,
        publicKey: taprootAddr.publicKey || "",
      });
    } catch (e: any) {
      setError(e?.message || "Failed to connect Xverse");
    } finally {
      setLoading(false);
    }
  }, [clearError, onConnect, network]);

  const connectUnisat = useCallback(async () => {
    setLoading(true);
    clearError();
    try {
      if (!window.unisat) {
        throw new Error(
          "Unisat wallet not detected. Please install the extension."
        );
      }

      const accounts = await window.unisat.requestAccounts();
      if (!accounts.length) {
        throw new Error("No accounts returned from Unisat");
      }

      const publicKey = await window.unisat.getPublicKey();

      onConnect({
        type: "unisat",
        address: accounts[0],
        publicKey: publicKey || "",
      });
    } catch (e: any) {
      setError(e?.message || "Failed to connect Unisat");
    } finally {
      setLoading(false);
    }
  }, [clearError, onConnect]);

  const handleTurnkeyCreate = useCallback(async () => {
    setLoading(true);
    clearError();
    try {
      const result = await client.createTurnkeyWallet({
        idempotencyKey: crypto.randomUUID(),
        body: { externalUserId },
      });

      onConnect({
        type: "turnkey",
        address: result.defaultAddress || "",
        publicKey: result.defaultPublicKeyHex || "",
        turnkeyResourceId: result.resourceId,
        isCustodial: true,
        organizationId: result.organizationId,
      });
    } catch (e: any) {
      setError(e?.message || "Failed to create Turnkey wallet");
    } finally {
      setLoading(false);
    }
  }, [client, externalUserId, clearError, onConnect]);

  const loadTurnkeyWallets = useCallback(async () => {
    setTurnkeyListLoading(true);
    clearError();
    try {
      const res = await client.listTurnkeyWallets(externalUserId);
      setTurnkeyWallets((res?.wallets as TurnkeyWalletEntry[]) ?? []);
    } catch (e: any) {
      setError(e?.message || "Failed to load Turnkey wallets");
      setTurnkeyWallets([]);
    } finally {
      setTurnkeyListLoading(false);
    }
  }, [client, externalUserId, clearError]);

  const selectTurnkeyWallet = useCallback(
    async (tw: TurnkeyWalletEntry) => {
      setLoading(true);
      clearError();
      try {
        const resourceId = tw.resourceId || tw.id;
        let address = tw.defaultAddress || "";
        let publicKey = tw.defaultPublicKeyHex || "";

        if (!address && resourceId) {
          const full = await client.getTurnkeyWallet({
            resourceId,
            externalUserId,
          });
          address = (full as any)?.defaultAddress || "";
          publicKey = (full as any)?.defaultPublicKeyHex || "";
        }

        if (!address) {
          throw new Error("Turnkey wallet has no address");
        }

        onConnect({
          type: "turnkey",
          address,
          publicKey,
          turnkeyResourceId: resourceId,
          isCustodial: tw.isCustodial ?? false,
          organizationId: tw.organizationId,
        });
      } catch (e: any) {
        setError(e?.message || "Failed to select Turnkey wallet");
      } finally {
        setLoading(false);
      }
    },
    [client, externalUserId, clearError, onConnect]
  );

  const openExistingPanel = useCallback(() => {
    setTurnkeyMode("existing");
    loadTurnkeyWallets();
  }, [loadTurnkeyWallets]);

  return (
    <div className="connect-view">
      <div className="connect-header">
        <h1 className="connect-title">Connect Your Wallet</h1>
        <p className="connect-description">
          Choose a wallet to interact with Arch Network
        </p>
      </div>

      <div className="network-selector">
        {NETWORKS.map((n) => (
          <button
            key={n}
            className={`network-option${network === n ? " active" : ""}`}
            onClick={() => handleNetworkChange(n)}
            type="button"
          >
            {n}
          </button>
        ))}
      </div>

      {error && (
        <div className="connect-error">
          <span className="connect-error-text">{error}</span>
          <button
            className="connect-error-dismiss"
            onClick={clearError}
            type="button"
          >
            ✕
          </button>
        </div>
      )}

      {!turnkeyMode && (
        <div className="wallet-cards">
          <button
            className="wallet-card"
            onClick={connectXverse}
            disabled={loading}
            type="button"
          >
            <div className="wallet-card-icon">₿</div>
            <div className="wallet-card-body">
              <span className="wallet-card-name">Xverse</span>
              <span className="wallet-card-desc">
                Bitcoin &amp; Ordinals wallet
              </span>
            </div>
            {loading && (
              <span className="spinner small" />
            )}
          </button>

          <button
            className="wallet-card"
            onClick={connectUnisat}
            disabled={loading}
            type="button"
          >
            <div className="wallet-card-icon">₿</div>
            <div className="wallet-card-body">
              <span className="wallet-card-name">Unisat</span>
              <span className="wallet-card-desc">
                Bitcoin browser extension
              </span>
            </div>
            {loading && (
              <span className="spinner small" />
            )}
          </button>

          <button
            className="wallet-card"
            onClick={() => setTurnkeyMode("create")}
            disabled={loading}
            type="button"
          >
            <div className="wallet-card-icon">🔐</div>
            <div className="wallet-card-body">
              <span className="wallet-card-name">Turnkey</span>
              <span className="wallet-card-desc">
                Managed passkey wallet
              </span>
            </div>
          </button>
        </div>
      )}

      {turnkeyMode === "create" && (
        <div className="turnkey-options">
          <button
            className="connect-back-btn"
            onClick={() => setTurnkeyMode(null)}
            type="button"
          >
            ← Back
          </button>
          <h2 className="turnkey-options-title">Turnkey Wallet</h2>
          <div className="turnkey-option-cards">
            <button
              className="wallet-card"
              onClick={handleTurnkeyCreate}
              disabled={loading}
              type="button"
            >
              <div className="wallet-card-icon">✨</div>
              <div className="wallet-card-body">
                <span className="wallet-card-name">Create New Wallet</span>
                <span className="wallet-card-desc">
                  Generate a new managed wallet
                </span>
              </div>
              {loading && <span className="spinner small" />}
            </button>

            <button
              className="wallet-card"
              onClick={openExistingPanel}
              disabled={loading}
              type="button"
            >
              <div className="wallet-card-icon">📋</div>
              <div className="wallet-card-body">
                <span className="wallet-card-name">Connect Existing</span>
                <span className="wallet-card-desc">
                  Select from your existing wallets
                </span>
              </div>
            </button>
          </div>
        </div>
      )}

      {turnkeyMode === "existing" && (
        <div className="turnkey-existing-panel">
          <button
            className="connect-back-btn"
            onClick={() => setTurnkeyMode("create")}
            type="button"
          >
            ← Back
          </button>
          <h2 className="turnkey-options-title">Select a Wallet</h2>

          {turnkeyListLoading ? (
            <div className="turnkey-loading">
              <span className="spinner" />
              <span>Loading wallets…</span>
            </div>
          ) : turnkeyWallets.length === 0 ? (
            <div className="turnkey-empty">
              No wallets found for this user.
            </div>
          ) : (
            <div className="turnkey-wallet-list">
              {turnkeyWallets.map((tw, i) => {
                const addr = tw.defaultAddress || "";
                const label =
                  tw.name || tw.walletName || `Wallet ${i + 1}`;
                return (
                  <button
                    key={tw.resourceId || tw.id || i}
                    className="turnkey-wallet-item"
                    onClick={() => selectTurnkeyWallet(tw)}
                    disabled={loading}
                    type="button"
                  >
                    <div className="turnkey-wallet-icon">🔐</div>
                    <div className="turnkey-wallet-info">
                      <span className="turnkey-wallet-name">{label}</span>
                      <span className="turnkey-wallet-address mono">
                        {addr
                          ? `${addr.slice(0, 12)}…${addr.slice(-6)}`
                          : "(no address)"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
