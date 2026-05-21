import type { ExternalWalletProvider, NetworkId } from "../state/types";
import {
  extractTapKeySigFromPsbtBase64,
  extractTapKeySigFromPsbtHex,
  hexToBytes,
} from "../utils/psbt-signature";

export interface ExternalWalletConnection {
  provider: ExternalWalletProvider;
  address: string;
  publicKeyHex: string;
}

export interface ExternalWalletAdapter {
  provider: ExternalWalletProvider;
  label: string;
  isInstalled(): boolean;
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

async function requestExternalWallet<T>(
  provider: ExternalWalletProvider,
  method: "connect" | "signMessage" | "signPsbt",
  args: Record<string, unknown>,
): Promise<T> {
  console.log("[ArchWallet] external request →", { provider, method, args });
  const response = await chrome.runtime.sendMessage({
    type: "EXTERNAL_WALLET_REQUEST",
    request: { provider, method, args },
  });
  console.log("[ArchWallet] external response ←", { provider, method, response });
  if (!response?.success) {
    throw new Error(
      response?.error ||
        "External wallet request failed. Open a normal web page tab where the wallet is injected, then retry.",
    );
  }
  return response.data as T;
}

export const externalWalletAdapters: Record<ExternalWalletProvider, ExternalWalletAdapter> = {
  xverse: {
    provider: "xverse",
    label: "Xverse",
    isInstalled: () => true,
    connect: (network) => requestExternalWallet("xverse", "connect", { network }),
    signMessage: async ({ address, message, network }) => ({
      ...(await requestExternalWallet<{ signature: string; schemeHint: "bip322" }>(
        "xverse",
        "signMessage",
        { address, message, network },
      )),
    }),
    signPsbt: async ({ address, psbtBase64, network }) => {
      const res = await requestExternalWallet<{ signedPsbtBase64?: string }>("xverse", "signPsbt", {
        address,
        psbtBase64,
        network,
      });
      if (!res.signedPsbtBase64) throw new Error("No signed PSBT returned from Xverse");
      return extractTapKeySigFromPsbtBase64(res.signedPsbtBase64);
    },
    signBtcPsbt: async ({ address, psbtBase64, network, inputIndexes }) => {
      const res = await requestExternalWallet<{ signedPsbtBase64?: string }>(
        "xverse",
        "signBtcPsbt",
        { address, psbtBase64, network, inputIndexes },
      );
      if (!res.signedPsbtBase64) throw new Error("No signed PSBT returned from Xverse");
      return { signedPsbtBase64: res.signedPsbtBase64 };
    },
  },
  unisat: {
    provider: "unisat",
    label: "UniSat",
    isInstalled: () => true,
    connect: (network) => requestExternalWallet("unisat", "connect", { network }),
    signMessage: async ({ message, network }) => ({
      ...(await requestExternalWallet<{ signature: string; schemeHint: "bip322" }>(
        "unisat",
        "signMessage",
        { message, network },
      )),
    }),
    signPsbt: async ({ psbtBase64, network }) => {
      const res = await requestExternalWallet<{ signedPsbtHex?: string }>("unisat", "signPsbt", {
        psbtBase64,
        network,
      });
      if (!res.signedPsbtHex) throw new Error("No signed PSBT returned from UniSat");
      return extractTapKeySigFromPsbtHex(res.signedPsbtHex);
    },
    signBtcPsbt: async ({ address, psbtBase64, network, inputIndexes }) => {
      const res = await requestExternalWallet<{ signedPsbtHex?: string }>(
        "unisat",
        "signBtcPsbt",
        { address, psbtBase64, network, inputIndexes },
      );
      if (!res.signedPsbtHex) throw new Error("No signed PSBT returned from UniSat");
      // UniSat returns the signed PSBT in hex; normalize to base64 so
      // every adapter has the same return shape regardless of provider.
      return { signedPsbtBase64: hexToBase64(res.signedPsbtHex) };
    },
  },
  magiceden: {
    provider: "magiceden",
    label: "Magic Eden",
    isInstalled: () => true,
    connect: (network) => requestExternalWallet("magiceden", "connect", { network }),
    signMessage: async ({ address, message, network }) => ({
      ...(await requestExternalWallet<{ signature: string; schemeHint: "bip322" }>(
        "magiceden",
        "signMessage",
        { address, message, network },
      )),
    }),
    signPsbt: async ({ address, psbtBase64, network }) => {
      const res = await requestExternalWallet<{ signedPsbtBase64?: string }>(
        "magiceden",
        "signPsbt",
        { address, psbtBase64, network },
      );
      if (!res.signedPsbtBase64) throw new Error("No signed PSBT returned from Magic Eden");
      return extractTapKeySigFromPsbtBase64(res.signedPsbtBase64);
    },
    signBtcPsbt: async ({ address, psbtBase64, network, inputIndexes }) => {
      const res = await requestExternalWallet<{ signedPsbtBase64?: string }>(
        "magiceden",
        "signBtcPsbt",
        { address, psbtBase64, network, inputIndexes },
      );
      if (!res.signedPsbtBase64) throw new Error("No signed PSBT returned from Magic Eden");
      return { signedPsbtBase64: res.signedPsbtBase64 };
    },
  },
};

export function getExternalWalletAdapter(provider: ExternalWalletProvider): ExternalWalletAdapter {
  return externalWalletAdapters[provider];
}
