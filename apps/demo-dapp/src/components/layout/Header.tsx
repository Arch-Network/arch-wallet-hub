import { useMemo } from "react";
import type { ArchNetwork } from "@arch/wallet-hub-sdk";
import type { ConnectedWallet } from "../../types";
import CopyButton from "../shared/CopyButton";
import { reEncodeTaprootAddress } from "../../utils/addressNetwork";

type HeaderProps = {
  wallet: ConnectedWallet;
  network: ArchNetwork;
  onNetworkChange: (n: ArchNetwork) => void;
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

function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

export default function Header({ wallet, network, onNetworkChange, onDisconnect }: HeaderProps) {
  const displayAddress = useMemo(
    () => reEncodeTaprootAddress(wallet.address, network),
    [wallet.address, network]
  );

  const toggleNetwork = () => {
    onNetworkChange(network === "mainnet" ? "testnet" : "mainnet");
  };

  return (
    <header className="app-header">
      <span className={`header-wallet-badge ${wallet.type}`}>
        {walletLabel(wallet.type)}
      </span>
      <span className="header-address" title={displayAddress}>
        {truncateAddress(displayAddress)}
      </span>
      <CopyButton text={displayAddress} />
      <button
        className={`header-network-toggle ${network}`}
        onClick={toggleNetwork}
        type="button"
        title="Click to switch network"
      >
        {network}
      </button>
      <button className="header-disconnect-btn" onClick={onDisconnect} type="button">
        Disconnect
      </button>
    </header>
  );
}
