import { useState, useEffect, useCallback } from "react";
import { walletStore } from "../state/wallet-store";
import { invalidateClientCache } from "../utils/sdk";
import type { AppState, WalletAccount, NetworkId } from "../state/types";
import { DEFAULT_STATE } from "../state/types";

export function useWallet() {
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const s = await walletStore.getState();
    setState(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if ("arch_wallet_state" in changes) {
        setState(changes.arch_wallet_state.newValue ?? DEFAULT_STATE);
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, [refresh]);

  const activeAccount: WalletAccount | null =
    state.accounts.find((a) => a.id === state.activeAccountId) ?? null;

  return {
    state,
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
    unlock: async () => {
      await walletStore.unlock();
      await refresh();
    },
  };
}
