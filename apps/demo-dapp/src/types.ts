import type { WalletHubClient } from "@arch-network/wallet-hub-sdk";

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

/** Only `isCustodial === false` (a passkey sub-org wallet) can sign. */
export const LEGACY_CUSTODIAL_UNSUPPORTED = "Legacy custodial wallets are no longer supported";

export type WalletContextProps = {
  client: WalletHubClient;
  wallet: ConnectedWallet;
  externalUserId: string;
};
