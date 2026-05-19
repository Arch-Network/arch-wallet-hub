import { useState, useEffect, useCallback } from "react";
import { walletStore } from "../state/wallet-store";
import { invalidateClientCache } from "../utils/sdk";
import { keystore, type MigrationStatus } from "../crypto/keystore";
import type { AppState, WalletAccount, NetworkId, RecipientAsset, Contact } from "../state/types";
import { DEFAULT_STATE } from "../state/types";

export interface WalletStateBundle {
  state: AppState;
  migration: MigrationStatus;
  loading: boolean;
}

export function useWallet() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [migration, setMigration] = useState<MigrationStatus>({ kind: "fresh" });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [s, m] = await Promise.all([
      walletStore.getState(),
      keystore.getMigrationStatus(),
    ]);
    setState(s);
    setMigration(m);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ("arch_wallet_keystore" in changes || "arch_wallet_state" in changes) {
        refresh();
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    let sessionListener: ((c: Record<string, chrome.storage.StorageChange>) => void) | null = null;
    try {
      sessionListener = () => {
        refresh();
      };
      chrome.storage.session?.onChanged.addListener(sessionListener);
    } catch {
      sessionListener = null;
    }
    return () => {
      chrome.storage.local.onChanged.removeListener(listener);
      if (sessionListener) {
        try {
          chrome.storage.session?.onChanged.removeListener(sessionListener);
        } catch {
          /* ignore */
        }
      }
    };
  }, [refresh]);

  const activeAccount: WalletAccount | null =
    state.accounts.find((a) => a.id === state.activeAccountId) ?? null;

  return {
    state,
    migration,
    loading,
    activeAccount,
    refresh,
    setNetwork: async (n: NetworkId) => {
      await walletStore.setNetwork(n);
      invalidateClientCache();
      await refresh();
    },
    lock: async () => {
      await walletStore.lock();
      await refresh();
    },
    unlock: async (password: string) => {
      // Step 1: decrypt the keystore. Throws on bad password.
      await walletStore.unlock(password);
      // Step 2: best-effort, open a Turnkey session for the active
      // account. For passkey wallets this means one WebAuthn prompt
      // right now; for email wallets it means doing nothing here
      // (the OTP step is handled by a dedicated UI flow that runs
      // before the first sign attempt). If WebAuthn is dismissed we
      // intentionally don't roll the keystore back to locked --
      // viewing balances and history should never depend on a
      // signing credential being live.
      try {
        const account = await walletStore.getActiveAccount();
        if (account?.authMethod === "passkey") {
          await walletStore.openPasskeySession();
        }
      } catch {
        // Swallow: the next sign attempt will throw SessionLockedError
        // and the UI re-prompts.
      }
      await refresh();
    },
    sealLegacy: async (password: string) => {
      if (migration.kind !== "needs_password") return;
      await walletStore.sealLegacyState(password, migration.legacyState);
      await refresh();
    },
    setAutoLockMinutes: async (minutes: number) => {
      await walletStore.setAutoLockMinutes(minutes);
      await refresh();
    },
    addRecentRecipient: async (entry: {
      address: string;
      asset: RecipientAsset;
      network: NetworkId;
      mint?: string;
      label?: string;
    }) => {
      await walletStore.addRecentRecipient(entry);
      await refresh();
    },
    removeRecentRecipient: async (entry: {
      address: string;
      asset: RecipientAsset;
      network: NetworkId;
      mint?: string;
    }) => {
      await walletStore.removeRecentRecipient(entry);
      await refresh();
    },
    clearRecentRecipients: async () => {
      await walletStore.clearRecentRecipients();
      await refresh();
    },
    upsertContact: async (entry: Omit<Contact, "createdAt" | "updatedAt">) => {
      await walletStore.upsertContact(entry);
      await refresh();
    },
    removeContact: async (entry: { address: string; network: NetworkId; mint?: string }) => {
      await walletStore.removeContact(entry);
      await refresh();
    },
  };
}
