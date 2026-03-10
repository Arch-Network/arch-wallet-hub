import type { ConnectedWallet } from "../../types";

type Props = {
  wallet: ConnectedWallet;
  onDisconnect: () => void;
};

function detectNetwork(address: string): "testnet" | "mainnet" {
  const testnetPrefixes = ["tb1", "bcrt1", "m", "n", "2"];
  return testnetPrefixes.some((p) => address.startsWith(p))
    ? "testnet"
    : "mainnet";
}

export default function SettingsView({
  wallet,
  onDisconnect,
}: Props) {
  const network = detectNetwork(wallet.address);

  return (
    <div className="settings-view">
      <h1 className="settings-title">Settings</h1>

      <div className="settings-section">
        <h2 className="settings-section-title">Wallet Info</h2>
        <div className="settings-info-grid">
          <div className="settings-info-row">
            <span className="settings-info-label">Wallet Type</span>
            <span className={`wallet-badge ${wallet.type}`}>
              {wallet.type}
            </span>
          </div>
          <div className="settings-info-row">
            <span className="settings-info-label">BTC Address</span>
            <code className="settings-info-value">{wallet.address}</code>
          </div>
          {wallet.archAddress && (
            <div className="settings-info-row">
              <span className="settings-info-label">Arch Address</span>
              <code className="settings-info-value">{wallet.archAddress}</code>
            </div>
          )}
          <div className="settings-info-row">
            <span className="settings-info-label">Public Key</span>
            <code className="settings-info-value">{wallet.publicKey}</code>
          </div>
          {wallet.organizationId && (
            <div className="settings-info-row">
              <span className="settings-info-label">Organization ID</span>
              <code className="settings-info-value">
                {wallet.organizationId}
              </code>
            </div>
          )}
        </div>
      </div>

      <div className="settings-section">
        <h2 className="settings-section-title">Network</h2>
        <div className="settings-network-badge">
          <span className={`pill ${network === "testnet" ? "warn" : "ok"}`}>
            {network === "testnet" ? "⚠ Testnet" : "✓ Mainnet"}
          </span>
        </div>
      </div>

      <div className="settings-section settings-danger">
        <h2 className="settings-section-title">Disconnect</h2>
        <p className="settings-danger-text">
          Disconnecting will clear your wallet session from this browser.
        </p>
        <button className="btn-danger" onClick={onDisconnect}>
          Disconnect Wallet
        </button>
      </div>
    </div>
  );
}
