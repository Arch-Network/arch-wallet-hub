import { AppState, DEFAULT_STATE, WalletAccount, NetworkId, ConnectedSite, DEFAULT_HUB_BASE_URL, DEFAULT_HUB_API_KEY } from "./types";
import { deriveArchAccountAddress } from "../utils/sdk";
import { INDEXER_BASE_URL, DEFAULT_INDEXER_API_KEY } from "../utils/explorer-config";

const STORAGE_KEY = "arch_wallet_state";

async function loadState(): Promise<AppState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? { ...DEFAULT_STATE };
}

async function saveState(state: AppState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

/**
 * One-shot migration from the legacy single-API config (apiBaseUrl/apiKey,
 * which targeted the Wallet Hub) to the new split config:
 *   - hubBaseUrl/hubApiKey   → Turnkey + signing-requests + custodial BTC
 *   - indexerBaseUrl/indexerApiKey → Arch Explorer Indexer (reads, faucet, BTC, RPC)
 */
function migrateApiConfig(state: any): boolean {
  let migrated = false;

  if (state.apiBaseUrl !== undefined || state.apiKey !== undefined) {
    if (!state.hubBaseUrl) state.hubBaseUrl = state.apiBaseUrl || DEFAULT_HUB_BASE_URL;
    if (!state.hubApiKey) state.hubApiKey = state.apiKey || DEFAULT_HUB_API_KEY;
    delete state.apiBaseUrl;
    delete state.apiKey;
    migrated = true;
  }

  if (!state.hubBaseUrl) {
    state.hubBaseUrl = DEFAULT_HUB_BASE_URL;
    migrated = true;
  }
  if (!state.hubApiKey) {
    state.hubApiKey = DEFAULT_HUB_API_KEY;
    migrated = true;
  }

  if (!state.indexerBaseUrl) {
    state.indexerBaseUrl = INDEXER_BASE_URL;
    migrated = true;
  }
  if (!state.indexerApiKey) {
    state.indexerApiKey = DEFAULT_INDEXER_API_KEY;
    migrated = true;
  }

  return migrated;
}

export const walletStore = {
  async getState(): Promise<AppState> {
    const state = (await loadState()) as any;
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

    if (migrateApiConfig(state)) migrated = true;

    if (migrated) await saveState(state);
    return state as AppState;
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

  async setHubConfig(hubBaseUrl: string, hubApiKey: string): Promise<void> {
    const state = await loadState();
    state.hubBaseUrl = hubBaseUrl;
    state.hubApiKey = hubApiKey;
    await saveState(state);
  },

  async setIndexerConfig(indexerBaseUrl: string, indexerApiKey: string): Promise<void> {
    const state = await loadState();
    state.indexerBaseUrl = indexerBaseUrl;
    state.indexerApiKey = indexerApiKey;
    await saveState(state);
  },

  async reset(): Promise<void> {
    await saveState({ ...DEFAULT_STATE });
  },
};
