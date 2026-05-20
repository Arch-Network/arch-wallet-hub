import { useState, useEffect, useCallback } from "react";
import { walletStore } from "../store/wallet-store";
import { invalidateClientCache } from "../utils/sdk";
import type { AppState, WalletAccount, NetworkId } from "../store/types";
import { DEFAULT_STATE } from "../store/types";

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
    const unsub = walletStore.subscribe(() => {
      walletStore.getState().then(setState);
    });
    return unsub;
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
