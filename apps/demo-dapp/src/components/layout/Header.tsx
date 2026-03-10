import type { ConnectedWallet } from "../../types";
import CopyButton from "../shared/CopyButton";

type HeaderProps = {
  wallet: ConnectedWallet;
  onDisconnect: () => void;
};

function walletLabel(type: ConnectedWallet["type"]): string {
  const labels: Record<ConnectedWallet["type"], string> = {
    xverse: "Xverse",
    unisat: "Unisat",
    turnkey: "Turnkey",
  };
  return labels[type];
}

function detectNetwork(address: string): "testnet" | "mainnet" {
  return address.startsWith("tb1") || address.startsWith("bcrt1") || address.startsWith("m") || address.startsWith("n")
    ? "testnet"
    : "mainnet";
}

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

export default function Header({ wallet, onDisconnect }: HeaderProps) {
  const network = detectNetwork(wallet.address);

  return (
    <header className="app-header">
      <span className={`header-wallet-badge ${wallet.type}`}>
        {walletLabel(wallet.type)}
      </span>
      <span className="header-address" title={wallet.address}>
        {truncateAddress(wallet.address)}
      </span>
      <CopyButton text={wallet.address} />
      <span className={`header-network-badge ${network}`}>{network}</span>
      <button className="header-disconnect-btn" onClick={onDisconnect} type="button">
        Disconnect
      </button>
    </header>
  );
}
