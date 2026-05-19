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

export default defineUnlistedScript({
  main() {
    if (typeof window === "undefined") return;

    Object.defineProperty(window, "arch", {
      value: archProvider,
      writable: false,
      configurable: false,
    });

    Object.defineProperty(window, "bitcoinArch", {
      value: bitcoinProvider,
      writable: false,
      configurable: false,
    });

    if (!(window as any).bitcoin) {
      // Only fill the namespace if nobody else owns it yet. Dapps that
      // want our provider explicitly should use `window.bitcoinArch`
      // or the wallet-standard registration below.
      try {
        Object.defineProperty(window, "bitcoin", {
          value: bitcoinProvider,
          writable: false,
          configurable: true,
        });
      } catch {
        /* another extension already claimed it; we don't fight */
      }
    }

    registerWalletStandard({ arch: archProvider, bitcoin: bitcoinProvider });

    window.dispatchEvent(new CustomEvent("arch-wallet#initialized"));
  },
});
