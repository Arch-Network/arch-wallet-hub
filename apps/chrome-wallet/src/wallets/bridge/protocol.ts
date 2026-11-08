/**
 * Messages between the extension UI and the injected script on the Hub
 * connector page, where Xverse and UniSat inject their providers. The
 * path is adapter → background → content script → injected script, and
 * back. Every hop forwards these shapes unchanged.
 */
import type { AddressPurpose, BtcAddressType, ExternalWalletProvider } from "../../state/types";

export type BridgeNetwork = "testnet4" | "mainnet";

export type BridgeRequest =
  | { provider: ExternalWalletProvider; method: "connect"; args: { network: BridgeNetwork } }
  | {
      provider: ExternalWalletProvider;
      method: "signMessage";
      args: { address: string; message: string; network: BridgeNetwork };
    }
  | {
      provider: ExternalWalletProvider;
      method: "signPsbt";
      args: { address: string; psbtBase64: string; network: BridgeNetwork };
    }
  | {
      provider: ExternalWalletProvider;
      method: "signBtcPsbt";
      args: { address: string; psbtBase64: string; network: BridgeNetwork; inputIndexes: number[] };
    };

export type BridgeMethod = BridgeRequest["method"];

/** An address as the provider returned it at connect time. */
export interface BridgeAddress {
  address: string;
  publicKeyHex: string;
  purposes: AddressPurpose[];
  addressType: BtcAddressType;
}

export interface BridgeConnectResult {
  provider: ExternalWalletProvider;
  /** Taproot address carrying the Arch identity; the ownership challenge signs with it. */
  address: string;
  publicKeyHex: string;
  addresses: BridgeAddress[];
  /** The provider reported the exact requested chain (not inferred from an address prefix). */
  chainVerified: boolean;
}

export type BridgeErrorCode =
  | "PROVIDER_MISSING"
  | "USER_REJECTED"
  | "WRONG_NETWORK"
  | "ACCOUNT_MISMATCH"
  | "UNSUPPORTED_ADDRESS"
  | "UNSUPPORTED"
  | "TIMEOUT"
  | "WINDOW_CLOSED"
  | "PROVIDER_ERROR";

export type BridgeResponse<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string; code: BridgeErrorCode };

/**
 * How long the content script waits for the injected script: long enough
 * to unlock the provider and read what's being approved, and under
 * Chrome's five-minute limit on a service-worker event so the background
 * is still alive to report the timeout. The connector window is not
 * idle-closed while a request is in flight.
 */
export const BRIDGE_TIMEOUT_MS: Record<BridgeMethod, number> = {
  connect: 120_000,
  signMessage: 180_000,
  signPsbt: 240_000,
  signBtcPsbt: 240_000,
};

export const BRIDGE_CHANNEL = "arch-wallet-external-wallet";
