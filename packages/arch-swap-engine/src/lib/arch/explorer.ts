import { envDefaultNetworkId, type NetworkId } from "@/engine-config";

const ARCH_EXPLORER_BASE_URLS: Record<NetworkId, string> = {
  mainnet: "https://explorer.arch.network",
  testnet: "https://explorer.arch.network/testnet",
};

export function getArchExplorerBaseUrl(networkId: NetworkId): string {
  return ARCH_EXPLORER_BASE_URLS[networkId];
}

export function getArchExplorerAccountUrl(
  archAddress: string,
  networkId: NetworkId = envDefaultNetworkId(),
): string {
  return `${getArchExplorerBaseUrl(networkId)}/accounts/${encodeURIComponent(archAddress)}`;
}

export function getArchExplorerTxUrl(
  txid: string,
  networkId: NetworkId = envDefaultNetworkId(),
): string {
  return `${getArchExplorerBaseUrl(networkId)}/tx/${encodeURIComponent(txid)}`;
}
