import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Thin wrapper over `expo-secure-store` for fields the audit
 * classified as cleartext-leaks-from-AsyncStorage. Values stored here
 * are encrypted by the OS (iOS Keychain / Android Keystore) and are
 * not bundled into the JS heap snapshot.
 *
 * On `web` we fall back to in-memory storage so the mobile-wallet's
 * web-preview build does not crash; the web target should never be
 * used for real funds and the wallet warns at boot if the API base URL
 * isn't set anyway.
 */

const memoryFallback = new Map<string, string>();

const SECURE_KEY_API_KEY = "arch_wallet_secure_api_key";
const SECURE_KEY_API_BASE_URL = "arch_wallet_secure_api_base_url";
const SECURE_KEY_DEVICE_ID = "arch_wallet_secure_device_id";

async function setItem(key: string, value: string | null | undefined): Promise<void> {
  if (Platform.OS === "web") {
    if (value == null) memoryFallback.delete(key);
    else memoryFallback.set(key, value);
    return;
  }
  if (value == null || value === "") {
    await SecureStore.deleteItemAsync(key);
    return;
  }
  await SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    return memoryFallback.get(key) ?? null;
  }
  return SecureStore.getItemAsync(key);
}

export const secureState = {
  async setApiCredentials(params: { apiKey: string | null; apiBaseUrl: string | null }) {
    await Promise.all([
      setItem(SECURE_KEY_API_KEY, params.apiKey),
      setItem(SECURE_KEY_API_BASE_URL, params.apiBaseUrl),
    ]);
  },
  async getApiCredentials(): Promise<{ apiKey: string | null; apiBaseUrl: string | null }> {
    const [apiKey, apiBaseUrl] = await Promise.all([
      getItem(SECURE_KEY_API_KEY),
      getItem(SECURE_KEY_API_BASE_URL),
    ]);
    return { apiKey, apiBaseUrl };
  },
  async setDeviceId(value: string | null) {
    await setItem(SECURE_KEY_DEVICE_ID, value);
  },
  async getDeviceId(): Promise<string | null> {
    return getItem(SECURE_KEY_DEVICE_ID);
  },
  async clear() {
    await Promise.all([
      setItem(SECURE_KEY_API_KEY, null),
      setItem(SECURE_KEY_API_BASE_URL, null),
      setItem(SECURE_KEY_DEVICE_ID, null),
    ]);
  },
};
