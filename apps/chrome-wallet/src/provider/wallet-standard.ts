/**
 * Phase 3.1 - wallet-standard registration.
 *
 * Implements the minimum surface area of the @wallet-standard/base
 * `Wallet` contract so dapps using a wallet-standard discovery loop
 * (sats-connect adapters, the Phantom-style multi-provider matrix,
 * etc.) can find us alongside other installed wallets without us
 * needing to squat any namespace.
 *
 * The actual signing/transfer methods proxy through the existing
 * arch+bitcoin providers, so this is a thin adapter rather than a
 * second implementation.
 *
 * Lazy bundling: the wallet-standard packages are large enough that
 * importing them eagerly bloats the injected bundle. We declare a
 * minimal local interface here and emit the standard
 * `wallet-standard:register-wallet` event with our shape; full
 * adoption can swap the local types out for the real packages later
 * without breaking the dispatched contract.
 */

export interface ArchInjectedProviders {
  arch: any;
  bitcoin: any;
}

interface WalletStandardWallet {
  version: string;
  name: string;
  icon: string;
  chains: ReadonlyArray<string>;
  features: Record<string, unknown>;
  accounts: ReadonlyArray<unknown>;
}

const WALLET_ICON =
  // Tiny inline PNG so the dapp picker has something to render before
  // we hand off to the wallet UI. Swap with a real branded data URL
  // when the design assets land.
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjMTExIi8+PHRleHQgeD0iMzIiIHk9IjQyIiBmb250LXNpemU9IjI4IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjYzE5YTViIj5BPC90ZXh0Pjwvc3ZnPg==";

function buildWalletStandardAdapter(providers: ArchInjectedProviders): WalletStandardWallet {
  const wallet: WalletStandardWallet = {
    version: "1.0.0",
    name: "Arch Wallet",
    icon: WALLET_ICON,
    chains: ["bitcoin:mainnet", "bitcoin:testnet", "arch:mainnet", "arch:testnet"],
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          const account = await providers.arch.connect();
          return { accounts: [{ address: account.address, publicKey: account.publicKey, chains: [], features: [] }] };
        },
      },
      "standard:disconnect": {
        version: "1.0.0",
        disconnect: async () => {
          await providers.arch.disconnect?.();
        },
      },
      "standard:events": {
        version: "1.0.0",
        on: providers.arch.on?.bind(providers.arch),
        off: providers.arch.removeListener?.bind(providers.arch),
      },
      "bitcoin:signPsbt": {
        version: "1.0.0",
        signPsbt: providers.bitcoin.signPsbt.bind(providers.bitcoin),
      },
      "bitcoin:signMessage": {
        version: "1.0.0",
        signMessage: providers.bitcoin.signMessage.bind(providers.bitcoin),
      },
      "arch:sendTransfer": {
        version: "1.0.0",
        sendTransfer: providers.arch.sendTransfer.bind(providers.arch),
      },
      "arch:sendTokenTransfer": {
        version: "1.0.0",
        sendTokenTransfer: providers.arch.sendTokenTransfer.bind(providers.arch),
      },
    },
    accounts: [],
  };
  return wallet;
}

export function registerWalletStandard(providers: ArchInjectedProviders): void {
  if (typeof window === "undefined") return;
  const wallet = buildWalletStandardAdapter(providers);

  const announce = () => {
    try {
      // The standard event payload is `{ register(callback) }`; we
      // accept the callback and pass our wallet object.
      const event = new CustomEvent("wallet-standard:register-wallet", {
        detail: ({ register }: any) => register(wallet),
      });
      window.dispatchEvent(event);
    } catch {
      /* old browsers without CustomEvent constructor */
    }
  };

  announce();
  window.addEventListener("wallet-standard:app-ready", announce);
}
