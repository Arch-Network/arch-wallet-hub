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
 *
 * The external-wallet bridge (src/wallets/bridge) also runs here, so
 * that on the Hub connector page it can reach Xverse and UniSat. It
 * only reads their globals; it never defines or replaces them.
 */

import { archProvider } from "../src/provider/arch-provider";
import { bitcoinProvider } from "../src/provider/bitcoin-provider";
import { registerWalletStandard } from "../src/provider/wallet-standard";
import { handleBridgeRequest } from "../src/wallets/bridge/handle";
import { BRIDGE_CHANNEL } from "../src/wallets/bridge/protocol";

const externalInFlight = new Set<string>();

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
        if (event.data?.channel !== BRIDGE_CHANNEL) return;
        if (event.data?.direction !== "to-page") return;
        const id = event.data.id;
        if (!id || externalInFlight.has(id)) return;
        externalInFlight.add(id);
        void handleBridgeRequest(event.data.request).then((response) => {
          externalInFlight.delete(id);
          window.postMessage(
            { channel: BRIDGE_CHANNEL, direction: "to-content", id, response },
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
