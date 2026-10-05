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

interface WalletStandardAccount {
  address: string;
  publicKey: Uint8Array;
  chains: ReadonlyArray<string>;
  features: ReadonlyArray<string>;
}

interface WalletStandardWallet {
  version: string;
  name: string;
  icon: string;
  chains: ReadonlyArray<string>;
  features: Record<string, unknown>;
  readonly accounts: ReadonlyArray<WalletStandardAccount>;
}

type ChangeListener = (properties: { accounts: ReadonlyArray<WalletStandardAccount> }) => void;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(hex) ? hex : "";
  return Uint8Array.from(clean.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** The connected address's encoding says which network the wallet is on. */
function chainsFor(address: string): string[] {
  return /^bc1/i.test(address) ? ["bitcoin:mainnet", "arch:mainnet"] : ["bitcoin:testnet", "arch:testnet"];
}

const WALLET_ICON =
  // Tiny inline PNG so the dapp picker has something to render before
  // we hand off to the wallet UI. Swap with a real branded data URL
  // when the design assets land.
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjMTExIi8+PHRleHQgeD0iMzIiIHk9IjQyIiBmb250LXNpemU9IjI4IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjYzE5YTViIj5BPC90ZXh0Pjwvc3ZnPg==";

export function buildWalletStandardAdapter(providers: ArchInjectedProviders): WalletStandardWallet {
  let accounts: WalletStandardAccount[] = [];
  const listeners = new Set<ChangeListener>();
  const setAccounts = (next: WalletStandardAccount[]) => {
    accounts = next;
    for (const listener of listeners) {
      try {
        listener({ accounts });
      } catch {
        /* a dapp listener's error must not break the others */
      }
    }
  };

  const features: Record<string, unknown> = {
    "standard:connect": {
      version: "1.0.0",
      connect: async () => {
        const account = await providers.arch.connect();
        setAccounts([
          {
            address: account.address,
            publicKey: hexToBytes(account.publicKey ?? ""),
            chains: chainsFor(account.address),
            features: Object.keys(features),
          },
        ]);
        return { accounts };
      },
    },
    "standard:disconnect": {
      version: "1.0.0",
      disconnect: async () => {
        await providers.arch.disconnect?.();
        setAccounts([]);
      },
    },
    "standard:events": {
      version: "1.0.0",
      on: (event: string, listener: ChangeListener) => {
        if (event !== "change") return () => {};
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    "bitcoin:signPsbt": {
      version: "1.0.0",
      signPsbt: providers.bitcoin.signPsbt.bind(providers.bitcoin),
    },
    "arch:sendTransfer": {
      version: "1.0.0",
      sendTransfer: providers.arch.sendTransfer.bind(providers.arch),
    },
    "arch:sendTokenTransfer": {
      version: "1.0.0",
      sendTokenTransfer: providers.arch.sendTokenTransfer.bind(providers.arch),
    },
  };

  return {
    version: "1.0.0",
    name: "Arch Wallet",
    icon: WALLET_ICON,
    chains: ["bitcoin:mainnet", "bitcoin:testnet", "arch:mainnet", "arch:testnet"],
    features,
    get accounts() {
      return accounts;
    },
  };
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
  // An app that loads after us announces itself; its event carries the register API.
  window.addEventListener("wallet-standard:app-ready", (event) => {
    try {
      (event as CustomEvent<{ register(wallet: WalletStandardWallet): unknown }>).detail?.register(wallet);
    } catch {
      /* malformed app-ready event */
    }
  });
}
