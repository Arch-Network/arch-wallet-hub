import type { WalletHubClient } from "@arch/wallet-hub-sdk";

export type WalletType = "xverse" | "unisat" | "turnkey";

export type ConnectedWallet = {
  type: WalletType;
  address: string;
  publicKey: string;
  archAddress?: string;
  turnkeyResourceId?: string;
  isCustodial?: boolean;
  organizationId?: string;
};

export type WalletContextProps = {
  client: WalletHubClient;
  wallet: ConnectedWallet;
  externalUserId: string;
};
