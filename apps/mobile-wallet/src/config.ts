/**
 * Build-time configuration for the mobile wallet.
 *
 * SECURITY: do NOT hardcode API keys here. Anything bundled into the
 * release APK / IPA is recoverable from a public install. Keys must be
 * supplied via Expo env vars (`EXPO_PUBLIC_*`) at build time, ideally
 * sourced from EAS secrets. The user can also override either value at
 * runtime via Settings (`walletStore.setApiConfig`).
 *
 * Required:
 *   EXPO_PUBLIC_API_BASE_URL  -> wallet-hub-api base URL
 *   EXPO_PUBLIC_API_KEY       -> platform-app API key
 *
 * Optional:
 *   EXPO_PUBLIC_API_BASE_URL_WEB -> override base URL when running in a
 *                                  browser preview (defaults to localhost)
 */
import { Platform } from "react-native";

const fallbackWeb = "http://localhost:3005";

function readEnv(name: string): string {
  const v = (process.env as Record<string, string | undefined>)[name];
  return typeof v === "string" ? v.trim() : "";
}

function resolveBaseUrl(): string {
  if (Platform.OS === "web") {
    return readEnv("EXPO_PUBLIC_API_BASE_URL_WEB") || fallbackWeb;
  }
  return readEnv("EXPO_PUBLIC_API_BASE_URL");
}

function resolveApiKey(): string {
  return readEnv("EXPO_PUBLIC_API_KEY");
}

export const API_BASE_URL = resolveBaseUrl();
export const API_KEY = resolveApiKey();

if (!API_BASE_URL && Platform.OS !== "web") {
  // eslint-disable-next-line no-console
  console.warn(
    "[arch-mobile-wallet] EXPO_PUBLIC_API_BASE_URL is not set; the wallet will run in an un-configured state until the user enters a base URL in Settings.",
  );
}
if (!API_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    "[arch-mobile-wallet] EXPO_PUBLIC_API_KEY is not set; the wallet will run in an un-configured state until the user enters an API key in Settings.",
  );
}
