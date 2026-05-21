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
import {
  AddressPurpose,
  BitcoinNetworkType,
  MessageSigningProtocols,
  getAddress,
  signMessage as xverseSignMessage,
  signTransaction as xverseSignTransaction,
  type GetAddressResponse,
  type SignTransactionResponse,
} from "sats-connect";

type ExternalProvider = "xverse" | "unisat";
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
    }
  | {
      provider: ExternalProvider;
      method: "signBtcPsbt";
      args: {
        address: string;
        psbtBase64: string;
        network: "testnet4" | "mainnet";
        inputIndexes: number[];
      };
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
  }
}

function xverseBitcoinNetwork(network: "testnet4" | "mainnet"): BitcoinNetworkType {
  // Xverse's legacy callback API accepts Testnet4 and will surface a
  // "Mismatched Network" modal if the user's wallet is set to a
  // different network -- this is the desired UX because it tells the
  // user exactly what to do (switch Xverse to Testnet4). We previously
  // tried mapping testnet4 -> Testnet in the hope that Xverse would
  // auto-bridge, but that path silently hangs instead of prompting, so
  // Testnet4 is the better trade.
  return network === "mainnet" ? BitcoinNetworkType.Mainnet : BitcoinNetworkType.Testnet4;
}

/**
 * Promisify sats-connect's legacy callback API (`getAddress`,
 * `signMessage`, `signTransaction`).
 *
 * Why legacy API: sats-connect's newer `request("wallet_connect", …)`
 * JSON-RPC dispatch goes through `BitcoinProvider.request(method,
 * params)` on Xverse. In some Xverse builds that method registers but
 * never resolves -- the approval popup never opens and the promise
 * hangs forever. The legacy callback API instead dispatches via
 * `BitcoinProvider.connect()` / `.signMessage()` / `.signTransaction()`,
 * which the Xverse SW actually responds to today.
 *
 * The callback API returns `Promise<void>` and reports its result
 * through `onFinish` / `onCancel`; this helper bridges it back to a
 * normal awaitable promise.
 */
function promisifyXverse<T>(
  fn: (opts: any) => Promise<void>,
  payload: any,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn({
      payload,
      onFinish: (response: T) => resolve(response),
      onCancel: () => reject(new Error(`${label} cancelled in Xverse`)),
    }).catch(reject);
  });
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

async function handleExternalRequest(req: ExternalRequest): Promise<unknown> {
  if (req.provider === "xverse") {
    const network = { type: xverseBitcoinNetwork(req.args.network) };

    if (req.method === "connect") {
      console.log("[ArchWallet] xverse getAddress → network", network.type);
      const response = await promisifyXverse<GetAddressResponse>(
        getAddress,
        {
          purposes: [AddressPurpose.Payment, AddressPurpose.Ordinals],
          message: "Connect to Arch Wallet",
          network,
        },
        "Connect",
      );
      console.log("[ArchWallet] xverse getAddress ← addresses:", response?.addresses?.length ?? 0);
      const taproot = pickTaprootAddress(response.addresses ?? []);
      if (!taproot?.address) throw new Error("No Taproot address found in Xverse");
      return { provider: "xverse", address: taproot.address, publicKeyHex: taproot.publicKey || "" };
    }

    if (req.method === "signMessage") {
      console.log("[ArchWallet] xverse signMessage → address", req.args.address);
      const signature = await promisifyXverse<string>(
        xverseSignMessage,
        {
          address: req.args.address,
          message: req.args.message,
          protocol: MessageSigningProtocols.BIP322,
          network,
        },
        "Sign message",
      );
      console.log(
        "[ArchWallet] xverse signMessage ←",
        signature ? `${signature.length} chars` : "<empty>",
      );
      return { signature, schemeHint: "bip322" };
    }

    // signPsbt and signBtcPsbt both go through legacy signTransaction
    // with broadcast: false -- the caller finalizes and pushes via our
    // indexer. The only difference is which input indexes are signed:
    // [0] for Arch PSBTs (single Taproot input), all UTXO indexes for
    // a BTC send.
    const signingIndexes = req.method === "signBtcPsbt" ? req.args.inputIndexes : [0];
    const txMessage =
      req.method === "signBtcPsbt" ? "Sign Bitcoin transaction" : "Sign Arch transaction";
    console.log(
      "[ArchWallet] xverse signTransaction →",
      req.method,
      "indexes:",
      signingIndexes,
    );
    const txResponse = await promisifyXverse<SignTransactionResponse>(
      xverseSignTransaction,
      {
        psbtBase64: req.args.psbtBase64,
        inputsToSign: [{ address: req.args.address, signingIndexes }],
        broadcast: false,
        message: txMessage,
        network,
      },
      "Sign transaction",
    );
    console.log("[ArchWallet] xverse signTransaction ← psbt:", txResponse?.psbtBase64?.length ?? 0);
    return { signedPsbtBase64: txResponse.psbtBase64 };
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
    if (req.method === "signPsbt") {
      return {
        signedPsbtHex: await window.unisat.signPsbt(base64ToHex(req.args.psbtBase64), {
          autoFinalized: false,
        }),
      };
    }
    // signBtcPsbt: pass each input index explicitly with our address so
    // UniSat targets exactly the UTXOs we built into the PSBT (no
    // ambiguity if the wallet holds multiple addresses). Keep
    // autoFinalized: false so our caller finalizes via bitcoinjs-lib;
    // the indexer broadcasts the extracted raw tx.
    return {
      signedPsbtHex: await window.unisat.signPsbt(base64ToHex(req.args.psbtBase64), {
        autoFinalized: false,
        toSignInputs: req.args.inputIndexes.map((index) => ({
          index,
          address: req.args.address,
        })),
      } as any),
    };
  }

  // Exhaustive guard: ExternalProvider is "xverse" | "unisat" today, so
  // we should never reach this. Throw a clear error so the connector UI
  // surfaces a usable message if a future provider sneaks in without a
  // branch above.
  throw new Error(`Unsupported external wallet provider: ${(req as any).provider}`);
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
