import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  AppState,
  DEFAULT_STATE,
  WalletAccount,
  NetworkId,
  ConnectedSite,
} from "./types";
import { deriveArchAccountAddress } from "../utils/crypto";
import { API_BASE_URL, API_KEY } from "../config";
import { secureState } from "./secure-state";

/**
 * AsyncStorage is unencrypted on disk and trivially exfiltrated from
 * a rooted device or a device backup. We persist only the
 * NON-sensitive subset (UI prefs, account metadata that's already on
 * chain) here. Anything secret -- API key, base URL -- goes through
 * `secureState` (expo-secure-store / iOS Keychain / Android
 * Keystore).
 */
const STORAGE_KEY = "arch_wallet_state";

/**
 * Old mobile-wallet builds shipped a literal API key in `src/config.ts`.
 * That key has been rotated; if any installed copy of the app still
 * has it persisted, drop it on read.
 */
const ROTATED_LEAKED_API_KEYS = new Set<string>([
  "x7NaU5AHiZ0UZxGLTm2WMqWsZkWB3B2cvnwL9RUDDLw",
]);

function stripPersistedSecrets(state: any): AppState {
  // Defensive: never let plaintext apiKey/apiBaseUrl leak back into
  // AsyncStorage. We materialize them at runtime from secure storage
  // / build env in `loadState`.
  if (state && typeof state === "object") {
    delete state.apiKey;
    delete state.apiBaseUrl;
  }
  return state as AppState;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn());
}

async function loadState(): Promise<AppState> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? stripPersistedSecrets(JSON.parse(raw)) : { ...DEFAULT_STATE };

    // Hydrate secrets from the secure store. If nothing is set we
    // fall through to the build-time values from `config.ts`, which
    // are themselves env-driven now (no literal keys in source).
    const creds = await secureState.getApiCredentials();
    const apiKey = creds.apiKey ?? API_KEY;
    const apiBaseUrl = creds.apiBaseUrl ?? API_BASE_URL;
    return { ...DEFAULT_STATE, ...parsed, apiKey, apiBaseUrl };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function saveState(state: AppState): Promise<void> {
  // Always strip secrets from the AsyncStorage blob; route them
  // through secureState. We mutate a shallow copy so callers' refs
  // are unaffected.
  const sanitized = stripPersistedSecrets({ ...state });
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
  notify();
}

export const walletStore = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  async getState(): Promise<AppState> {
    const state = await loadState();
    let migrated = false;
    // If a previously-installed copy of the app persisted the
    // now-leaked API key into AsyncStorage, blank it from secure
    // storage on the next read (we'll fall back to build-time env).
    if (state.apiKey && ROTATED_LEAKED_API_KEYS.has(state.apiKey)) {
      await secureState.setApiCredentials({ apiKey: null, apiBaseUrl: state.apiBaseUrl });
      state.apiKey = API_KEY;
      migrated = true;
    }
    for (const acct of state.accounts) {
      if ((acct as any).isCustodial === undefined) {
        (acct as any).isCustodial = true;
        migrated = true;
      }
      if (
        !acct.archAddress &&
        acct.publicKeyHex &&
        acct.publicKeyHex.length >= 64
      ) {
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
    return (
      state.accounts.find((a) => a.id === state.activeAccountId) ?? null
    );
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
    // Persist the credentials to the OS-backed secure store ONLY;
    // the in-memory state mirror is just for read-after-write.
    await secureState.setApiCredentials({ apiBaseUrl, apiKey });
    const state = await loadState();
    state.apiBaseUrl = apiBaseUrl;
    state.apiKey = apiKey;
    await saveState(state);
  },

  async reset(): Promise<void> {
    // Wipe both the public state blob and any OS-stored secrets.
    await secureState.clear();
    await saveState({ ...DEFAULT_STATE });
  },
};
