import type { AccountAddress, NetworkId, WalletAccount } from "../state/types";
import { BridgeError, shortAddress } from "./bridge/errors";
import type { BridgeConnectResult } from "./bridge/protocol";

/** The address records a connect result vouches for on `network`. */
export function connectionAddresses(connected: BridgeConnectResult, network: NetworkId): AccountAddress[] {
  return connected.addresses.map((a) => ({
    address: a.address,
    publicKeyHex: a.publicKeyHex || undefined,
    purposes: a.purposes,
    network,
    addressType: a.addressType,
    chainVerified: connected.chainVerified,
  }));
}

/**
 * The account's address records with `network`'s replaced by a fresh
 * connect result. The wallet must report the account's own Taproot
 * address: that is the key behind its Arch identity, so a different one
 * is a different account and is refused rather than merged.
 */
export function relinkedAddresses(
  account: WalletAccount,
  connected: BridgeConnectResult,
  network: NetworkId,
): AccountAddress[] {
  if (connected.address !== account.btcAddress) {
    const label = account.externalProvider === "unisat" ? "UniSat" : "Xverse";
    throw new BridgeError(
      "ACCOUNT_MISMATCH",
      `${label} is on a different account (${shortAddress(connected.address)}). Switch to ${shortAddress(account.btcAddress)} in ${label}, then try again.`,
    );
  }
  const otherNetworks = (account.addresses ?? []).filter((r) => r.network !== network);
  return [...otherNetworks, ...connectionAddresses(connected, network)];
}
