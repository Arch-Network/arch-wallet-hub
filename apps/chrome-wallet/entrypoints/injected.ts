/**
 * Injected provider script.
 *
 * Hardenings (Phase 3.1 + 3.3):
 *   - We no longer "squat" `window.bitcoin`. Many BTC dapps rely on
 *     other providers shipping that namespace; we now expose ourselves
 *     via `window.bitcoinArch`, `window.arch`, and wallet-standard
 *     registration so dapps can pick us via the multi-provider
 *     discovery mechanism without us hijacking other wallets.
 *   - All provider helpers share a single `RpcChannel`, scoped to
 *     `window.location.origin`, so we never receive messages from
 *     other windows.
 *
 * Backwards compatibility: a `window.bitcoin` shim is still installed
 * if (and only if) no other extension has claimed it.
 */

import { archProvider } from "../src/provider/arch-provider";
import { bitcoinProvider } from "../src/provider/bitcoin-provider";
import { registerWalletStandard } from "../src/provider/wallet-standard";
import { AddressPurpose, request } from "sats-connect";

type ExternalProvider = "xverse" | "unisat" | "magiceden";
type ExternalRequest =
  | { provider: ExternalProvider; method: "connect"; args: { network: "testnet4" | "mainnet" } }
  | {
      provider: ExternalProvider;
      method: "signMessage";
      args: { address: string; message: string; network: "testnet4" | "mainnet" };
    }
  | {
      provider: ExternalProvider;
      method: "signPsbt";
      args: { address: string; psbtBase64: string; network: "testnet4" | "mainnet" };
    };

const externalInFlight = new Set<string>();

declare global {
  interface Window {
    unisat?: {
      requestAccounts(): Promise<string[]>;
      getPublicKey(): Promise<string>;
      signMessage?(message: string, type?: string): Promise<string>;
      signPsbt?(psbtHex: string, options?: { autoFinalized?: boolean }): Promise<string>;
    };
    magicEden?: {
      bitcoin?: any;
    };
  }
}

function satsNetwork(network: "testnet4" | "mainnet"): "Mainnet" | "Testnet" {
  return network === "mainnet" ? "Mainnet" : "Testnet";
}

function xverseNetwork(network: "testnet4" | "mainnet"): "Mainnet" | "Testnet4" {
  // BitcoinNetworkType in sats-connect 4.x supports "Testnet4" directly
  // for wallet_connect. Pass it through so the user is not nagged with
  // a redundant network-switch modal when Xverse is already on Testnet4.
  return network === "mainnet" ? "Mainnet" : "Testnet4";
}

function describeXverseFailure(prefix: string, response: any): Error {
  const code = response?.error?.code;
  const message = response?.error?.message || "Xverse request failed";
  // Surface code + message together so we can tell apart "Invalid
  // parameters" (validation), "User rejected", "Wallet locked", etc.
  // when the only thing the popup gets back is a string. We also
  // serialize `error.data` (Xverse 4.x sometimes attaches a hint
  // describing which field failed validation).
  let detail = code != null ? `${message} (code ${code})` : message;
  const data = response?.error?.data;
  if (data !== undefined) {
    try {
      detail += ` data=${JSON.stringify(data)}`;
    } catch {
      detail += ` data=<unserializable>`;
    }
  }
  console.warn(`[ArchWallet] ${prefix} failed:`, response);
  return new Error(`${prefix}: ${detail}`);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToHex(base64: string): string {
  return bytesToHex(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

function pickTaprootAddress(addresses: any[]): any | null {
  return (
    addresses.find((a) => a.purpose === "ordinals") ||
    addresses.find((a) => a.address?.startsWith("tb1p") || a.address?.startsWith("bc1p")) ||
    null
  );
}

function magicEdenProvider(): any | null {
  const direct = window.magicEden?.bitcoin;
  if (direct) return direct;
  const legacy = (window as any).BitcoinProvider;
  return legacy?.isMagicEden ? legacy : null;
}

async function handleExternalRequest(req: ExternalRequest): Promise<unknown> {
  if (req.provider === "xverse") {
    if (req.method === "connect") {
      const params = {
        addresses: [AddressPurpose.Payment, AddressPurpose.Ordinals],
        message: "Connect to Arch Wallet",
        network: xverseNetwork(req.args.network),
      };
      console.log("[ArchWallet] xverse wallet_connect →", params);
      const response: any = await request("wallet_connect" as any, params as any);
      console.log("[ArchWallet] xverse wallet_connect ←", response);
      if (response?.status !== "success") {
        throw describeXverseFailure("Xverse connect", response);
      }
      const taproot = pickTaprootAddress(response.result?.addresses ?? []);
      if (!taproot?.address) throw new Error("No Taproot address found in Xverse");
      return { provider: "xverse", address: taproot.address, publicKeyHex: taproot.publicKey || "" };
    }
    if (req.method === "signMessage") {
      const params = {
        address: req.args.address,
        message: req.args.message,
        protocol: "BIP322",
      };
      console.log("[ArchWallet] xverse signMessage →", {
        address: params.address,
        protocol: params.protocol,
        messageLength: params.message.length,
        messagePreview: params.message.slice(0, 120),
      });
      const response: any = await request("signMessage", params as any);
      console.log("[ArchWallet] xverse signMessage ←", response);
      if (response?.status !== "success") {
        throw describeXverseFailure("Xverse signMessage", response);
      }
      return { signature: response.result?.signature, schemeHint: "bip322" };
    }
    const response: any = await request("signPsbt", {
      psbt: req.args.psbtBase64,
      signInputs: { [req.args.address]: [0] },
      broadcast: false,
    } as any);
    console.log("[ArchWallet] xverse signPsbt ←", response);
    if (response?.status !== "success") {
      throw describeXverseFailure("Xverse signPsbt", response);
    }
    return { signedPsbtBase64: response.result?.psbt };
  }

  if (req.provider === "unisat") {
    if (!window.unisat) throw new Error("UniSat wallet not detected in this tab");
    if (req.method === "connect") {
      const accounts = await window.unisat.requestAccounts();
      const address = accounts[0];
      if (!address) throw new Error("No account returned from UniSat");
      return { provider: "unisat", address, publicKeyHex: (await window.unisat.getPublicKey()) || "" };
    }
    if (req.method === "signMessage") {
      if (!window.unisat.signMessage) throw new Error("UniSat message signing is not available");
      return {
        signature: await window.unisat.signMessage(req.args.message, "bip322-simple"),
        schemeHint: "bip322",
      };
    }
    if (!window.unisat.signPsbt) throw new Error("UniSat PSBT signing is not available");
    return {
      signedPsbtHex: await window.unisat.signPsbt(base64ToHex(req.args.psbtBase64), {
        autoFinalized: false,
      }),
    };
  }

  const provider = magicEdenProvider();
  if (!provider) throw new Error("Magic Eden wallet not detected in this tab");
  if (req.method === "connect") {
    const raw = provider.connect ? await provider.connect() : await provider.getAccounts?.();
    const addresses = Array.isArray(raw) ? raw : raw?.addresses ?? [];
    const taproot = pickTaprootAddress(addresses);
    if (!taproot?.address) throw new Error("No Taproot address found in Magic Eden");
    return { provider: "magiceden", address: taproot.address, publicKeyHex: taproot.publicKey || "" };
  }
  if (req.method === "signMessage") {
    if (!provider.signMessage) throw new Error("Magic Eden message signing is not available");
    return {
      signature: await provider.signMessage({
        address: req.args.address,
        message: req.args.message,
        protocol: "BIP322",
      }),
      schemeHint: "bip322",
    };
  }
  const signer = provider.signPsbt ?? provider.signTransaction;
  if (!signer) throw new Error("Magic Eden PSBT signing is not available");
  const result = await signer.call(provider, {
    network: satsNetwork(req.args.network),
    message: "Sign Arch transaction",
    psbtBase64: req.args.psbtBase64,
    broadcast: false,
    inputsToSign: [{ address: req.args.address, signingIndexes: [0] }],
  });
  return {
    signedPsbtBase64:
      typeof result === "string" ? result : result.psbtBase64 || result.signedPsbtBase64,
  };
}

export default defineUnlistedScript({
  main() {
    if (typeof window === "undefined") return;
    const w = window as any;
    if (w.__ARCH_WALLET_INJECTED_SCRIPT_INSTALLED) return;
    w.__ARCH_WALLET_INJECTED_SCRIPT_INSTALLED = true;

    defineProviderGlobal("arch", archProvider, false);
    defineProviderGlobal("bitcoinArch", bitcoinProvider, false);

    if (!(window as any).bitcoin) {
      // Only fill the namespace if nobody else owns it yet. Dapps that
      // want our provider explicitly should use `window.bitcoinArch`
      // or the wallet-standard registration below.
      defineProviderGlobal("bitcoin", bitcoinProvider, true);
    }

    registerWalletStandard({ arch: archProvider, bitcoin: bitcoinProvider });

    if (!(window as any).__ARCH_WALLET_EXTERNAL_BRIDGE_INSTALLED) {
      (window as any).__ARCH_WALLET_EXTERNAL_BRIDGE_INSTALLED = true;
      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        if (event.origin !== window.location.origin) return;
        if (event.data?.channel !== "arch-wallet-external-wallet") return;
        if (event.data?.direction !== "to-page") return;
        const id = event.data.id;
        if (!id || externalInFlight.has(id)) return;
        externalInFlight.add(id);
        const finish = () => externalInFlight.delete(id);
        handleExternalRequest(event.data.request)
          .then((data) => {
            finish();
            window.postMessage(
              {
                channel: "arch-wallet-external-wallet",
                direction: "to-content",
                id,
                response: { success: true, data },
              },
              window.location.origin,
            );
          })
          .catch((err) => {
            finish();
            window.postMessage(
              {
                channel: "arch-wallet-external-wallet",
                direction: "to-content",
                id,
                response: { success: false, error: err?.message || "External wallet request failed" },
              },
              window.location.origin,
            );
          });
      });
    }

    window.dispatchEvent(new CustomEvent("arch-wallet#initialized"));
  },
});

function defineProviderGlobal(name: string, value: unknown, configurable: boolean): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, name);
  if (descriptor) return;
  try {
    Object.defineProperty(window, name, {
      value,
      writable: false,
      configurable,
    });
  } catch {
    // Another extension/script won the race. Do not break page execution.
  }
}
