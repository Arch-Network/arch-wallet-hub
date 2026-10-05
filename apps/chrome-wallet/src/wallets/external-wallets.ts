import type { ExternalWalletProvider, NetworkId } from "../state/types";
import {
  extractTapKeySigFromPsbtBase64,
  extractTapKeySigFromPsbtHex,
  hexToBytes,
} from "../utils/psbt-signature";
import { BridgeError } from "./bridge/errors";
import type { BridgeConnectResult, BridgeRequest, BridgeResponse } from "./bridge/protocol";

export type ExternalWalletConnection = BridgeConnectResult;

export interface ExternalWalletAdapter {
  provider: ExternalWalletProvider;
  label: string;
  /** Where to get the wallet when the connector page can't find it. */
  installUrl: string;
  /**
   * Connect and return every payment/ordinals address the wallet gave,
   * after the bridge checked the provider is present and on `network`.
   */
  connect(network: NetworkId): Promise<ExternalWalletConnection>;
  signMessage(args: {
    address: string;
    message: string;
    network: NetworkId;
  }): Promise<{ signature: string; schemeHint: "bip322" | "wallet_specific" }>;
  /**
   * BIP-322 signing for Hub-driven ARCH / APL flows. The Hub builds a
   * single-input PSBT where the lone input is owned by the user's
   * Taproot address; we ask the wallet to sign input 0 only and return
   * the extracted 64-byte Schnorr sig so the Hub can verify it against
   * the Taproot output key.
   */
  signPsbt(args: {
    address: string;
    psbtBase64: string;
    network: NetworkId;
  }): Promise<string>;
  /**
   * Full BTC PSBT signing for native BTC sends. The PSBT has N inputs
   * (all owned by `address`); the wallet signs every index in
   * `inputIndexes` and returns the signed PSBT. The caller finalizes
   * + broadcasts via our indexer, so we always set `broadcast: false`
   * downstream.
   */
  signBtcPsbt(args: {
    address: string;
    psbtBase64: string;
    network: NetworkId;
    inputIndexes: number[];
  }): Promise<{ signedPsbtBase64: string }>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function hexToBase64(hex: string): string {
  return bytesToBase64(hexToBytes(hex));
}

/** Throws `BridgeError` carrying the bridge's code, so callers can tell a rejection from a wrong network. */
async function requestExternalWallet<T>(request: BridgeRequest): Promise<T> {
  const response: BridgeResponse<T> | undefined = await chrome.runtime.sendMessage({
    type: "EXTERNAL_WALLET_REQUEST",
    request,
  });
  if (!response) throw new BridgeError("PROVIDER_ERROR", "The wallet connection didn't respond. Try again.");
  if (!response.success) throw new BridgeError(response.code ?? "PROVIDER_ERROR", response.error);
  return response.data;
}

function makeAdapter(
  provider: ExternalWalletProvider,
  label: string,
  installUrl: string,
  /** How the signed PSBT comes back: Xverse returns base64, UniSat hex. */
  signedPsbtField: "signedPsbtBase64" | "signedPsbtHex",
): ExternalWalletAdapter {
  const signedPsbt = (res: Record<string, string | undefined>): string => {
    const value = res[signedPsbtField];
    if (!value) throw new BridgeError("PROVIDER_ERROR", `${label} didn't return a signed transaction.`);
    return value;
  };
  return {
    provider,
    label,
    installUrl,
    connect: (network) => requestExternalWallet({ provider, method: "connect", args: { network } }),
    signMessage: (args) => requestExternalWallet({ provider, method: "signMessage", args }),
    signPsbt: async (args) => {
      const signed = signedPsbt(await requestExternalWallet({ provider, method: "signPsbt", args }));
      return signedPsbtField === "signedPsbtHex"
        ? extractTapKeySigFromPsbtHex(signed)
        : extractTapKeySigFromPsbtBase64(signed);
    },
    signBtcPsbt: async (args) => {
      const signed = signedPsbt(await requestExternalWallet({ provider, method: "signBtcPsbt", args }));
      return { signedPsbtBase64: signedPsbtField === "signedPsbtHex" ? hexToBase64(signed) : signed };
    },
  };
}

export const externalWalletAdapters: Record<ExternalWalletProvider, ExternalWalletAdapter> = {
  xverse: makeAdapter("xverse", "Xverse", "https://www.xverse.app/download", "signedPsbtBase64"),
  unisat: makeAdapter("unisat", "UniSat", "https://unisat.io/download", "signedPsbtHex"),
};

export function getExternalWalletAdapter(provider: ExternalWalletProvider): ExternalWalletAdapter {
  return externalWalletAdapters[provider];
}
