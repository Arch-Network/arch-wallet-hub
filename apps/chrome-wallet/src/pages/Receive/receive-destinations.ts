import type { ResolvedAddresses } from "../../state/account-addresses";
import type { NetworkId } from "../../state/types";

export type ReceiveTab = "btc" | "ordinals" | "arch";

export interface ReceiveDestination {
  id: ReceiveTab;
  tabLabel: string;
  title: string;
  /** null when the account has no verified address for this purpose on the network. */
  address: string | null;
  network: string;
  /** What may be sent here, for the warning line. */
  accepts: string;
  note?: string;
}

/**
 * Where each kind of asset should be received, from verified addresses
 * only. Payment and ordinals stay separate when the wallet gave two
 * addresses, and a shared address says so instead of being shown twice.
 */
export function receiveDestinations(
  resolved: ResolvedAddresses,
  archAddress: string,
  network: NetworkId,
  signerLabel: string,
): ReceiveDestination[] {
  const btcNetwork = network === "testnet4" ? "Bitcoin Testnet4" : "Bitcoin Mainnet";
  const archNetwork = network === "testnet4" ? "Arch Testnet" : "Arch Mainnet";
  const { payment, ordinals, identity } = resolved;
  const shared = payment !== null && payment === ordinals;

  const btc: ReceiveDestination = shared
    ? {
        id: "btc",
        tabLabel: "Bitcoin",
        title: "Bitcoin address",
        address: payment,
        network: btcNetwork,
        accepts: "BTC, Ordinals, and Runes",
        note: "This one address receives BTC, Ordinals, and Runes for this account.",
      }
    : {
        id: "btc",
        tabLabel: "Bitcoin",
        title: "Bitcoin payment address",
        address: payment,
        network: btcNetwork,
        accepts: "BTC",
        note:
          payment && payment !== identity
            ? `Spend BTC received here in ${signerLabel}. Arch Wallet sends BTC from your Taproot address.`
            : undefined,
      };

  const destinations = [btc];
  if (!shared && ordinals) {
    destinations.push({
      id: "ordinals",
      tabLabel: "Ordinals",
      title: "Ordinals address",
      address: ordinals,
      network: btcNetwork,
      accepts: "Ordinals and Runes",
    });
  }
  destinations.push({
    id: "arch",
    tabLabel: "Arch",
    title: "Arch address",
    address: archAddress || null,
    network: archNetwork,
    accepts: "ARCH and Arch tokens",
  });
  return destinations;
}
