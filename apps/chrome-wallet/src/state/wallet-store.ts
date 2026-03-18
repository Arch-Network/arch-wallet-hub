import { AppState, DEFAULT_STATE, WalletAccount, NetworkId, ConnectedSite } from "./types";
import { deriveArchAccountAddress } from "../utils/sdk";

const STORAGE_KEY = "arch_wallet_state";

async function loadState(): Promise<AppState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? { ...DEFAULT_STATE };
}

async function saveState(state: AppState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

export const walletStore = {
  async getState(): Promise<AppState> {
    const state = await loadState();
    let migrated = false;
    for (const acct of state.accounts) {
      if ((acct as any).isCustodial === undefined) {
        (acct as any).isCustodial = true;
        migrated = true;
      }
      if (!acct.archAddress && acct.publicKeyHex && acct.publicKeyHex.length >= 64) {
        acct.archAddress = deriveArchAccountAddress(acct.publicKeyHex);
        migrated = true;
      }
    }
    if (migrated) await saveState(state);
    return state;
  },

  async initialize(): Promise<void> {
    const state = await loadState();
    if (!state.initialized) {
      await saveState({ ...DEFAULT_STATE, initialized: false });
    }
  },

  async completeOnboarding(account: WalletAccount): Promise<void> {
    const state = await loadState();
    state.initialized = true;
    state.locked = false;
    const existing = state.accounts.find((a) => a.id === account.id);
    if (!existing) {
      state.accounts.push(account);
    }
    state.activeAccountId = account.id;
    await saveState(state);
  },

  async addAccount(account: WalletAccount): Promise<void> {
    const state = await loadState();
    state.accounts.push(account);
    if (!state.activeAccountId) {
      state.activeAccountId = account.id;
    }
    await saveState(state);
  },

  async setActiveAccount(accountId: string): Promise<void> {
    const state = await loadState();
    state.activeAccountId = accountId;
    await saveState(state);
  },

  async getActiveAccount(): Promise<WalletAccount | null> {
    const state = await loadState();
    if (!state.activeAccountId) return null;
    return state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
  },

  async setNetwork(network: NetworkId): Promise<void> {
    const state = await loadState();
    state.network = network;
    await saveState(state);
  },

  async lock(): Promise<void> {
    const state = await loadState();
    state.locked = true;
    await saveState(state);
  },

  async unlock(): Promise<void> {
    const state = await loadState();
    state.locked = false;
    await saveState(state);
  },

  async connectSite(origin: string, site: ConnectedSite): Promise<void> {
    const state = await loadState();
    state.connectedSites[origin] = site;
    await saveState(state);
  },

  async disconnectSite(origin: string): Promise<void> {
    const state = await loadState();
    delete state.connectedSites[origin];
    await saveState(state);
  },

  async isSiteConnected(origin: string): Promise<boolean> {
    const state = await loadState();
    return origin in state.connectedSites;
  },

  async setApiConfig(apiBaseUrl: string, apiKey: string): Promise<void> {
    const state = await loadState();
    state.apiBaseUrl = apiBaseUrl;
    state.apiKey = apiKey;
    await saveState(state);
  },

  async reset(): Promise<void> {
    await saveState({ ...DEFAULT_STATE });
  },
};
