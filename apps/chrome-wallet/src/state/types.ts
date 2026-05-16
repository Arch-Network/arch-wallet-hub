export type NetworkId = "testnet4" | "mainnet";
export type OpenAsMode = "popup" | "sidepanel";

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

  // How the toolbar icon opens the wallet UI.
  openAs: OpenAsMode;
}

export interface ConnectedSite {
  origin: string;
  name?: string;
  iconUrl?: string;
  connectedAt: number;
  accountId: string;
}

export const DEFAULT_HUB_BASE_URL = "http://wallet-hub-alb-1812078009.us-east-1.elb.amazonaws.com";
export const DEFAULT_HUB_API_KEY = "n63cYrYqamWINppvktPb9OkzxPg69SYfc0zRGnGGUhQ";

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
  openAs: "sidepanel",
};
