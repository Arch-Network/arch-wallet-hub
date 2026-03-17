import { archProvider } from "../src/provider/arch-provider";
import { bitcoinProvider } from "../src/provider/bitcoin-provider";

export default defineUnlistedScript({
  main() {
    if (typeof window === "undefined") return;

    Object.defineProperty(window, "arch", {
      value: archProvider,
      writable: false,
      configurable: false,
    });

    Object.defineProperty(window, "bitcoin", {
      value: Object.assign({}, (window as any).bitcoin, bitcoinProvider),
      writable: false,
      configurable: false,
    });

    window.dispatchEvent(new CustomEvent("arch-wallet#initialized"));
  },
});
