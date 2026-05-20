import type { ExternalWalletProvider, NetworkId } from "../state/types";
import {
  extractTapKeySigFromPsbtBase64,
  extractTapKeySigFromPsbtHex,
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
  signPsbt(args: {
    address: string;
    psbtBase64: string;
    network: NetworkId;
  }): Promise<string>;
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
  },
};

export function getExternalWalletAdapter(provider: ExternalWalletProvider): ExternalWalletAdapter {
  return externalWalletAdapters[provider];
}
