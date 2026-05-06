export type NetworkId = "testnet4" | "mainnet";

export interface WalletAccount {
  id: string;
  label: string;
  btcAddress: string;
  publicKeyHex: string;
  archAddress?: string;
  turnkeyResourceId: string;
  organizationId: string;
  isCustodial: boolean;
  createdAt: number;
}

export interface AppState {
  initialized: boolean;
  locked: boolean;
  network: NetworkId;
  activeAccountId: string | null;
  accounts: WalletAccount[];
  connectedSites: Record<string, ConnectedSite>;

  // Wallet Hub API (Turnkey + signing-requests + custodial BTC send)
  hubBaseUrl: string;
  hubApiKey: string;

  // Arch Explorer Indexer API (reads + faucet + BTC + Arch RPC compat)
  indexerBaseUrl: string;
  indexerApiKey: string;
}

export interface ConnectedSite {
  origin: string;
  name?: string;
  iconUrl?: string;
  connectedAt: number;
  accountId: string;
}

export const DEFAULT_HUB_BASE_URL = "http://44.222.123.237:3005";
export const DEFAULT_HUB_API_KEY = "D3DqTHT1JgTAzyYWiZmZ0KWjKJ-f_Tiilw_VtrW9Wog";

export const DEFAULT_STATE: AppState = {
  initialized: false,
  locked: true,
  network: "testnet4",
  activeAccountId: null,
  accounts: [],
  connectedSites: {},
  hubBaseUrl: DEFAULT_HUB_BASE_URL,
  hubApiKey: DEFAULT_HUB_API_KEY,
  indexerBaseUrl: "",
  indexerApiKey: "",
};
