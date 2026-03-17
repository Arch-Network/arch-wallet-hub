import { WalletHubClient } from "@arch/wallet-hub-sdk";
import { walletStore } from "../state/wallet-store";

let cachedClient: WalletHubClient | null = null;
let cachedBaseUrl: string | null = null;
let cachedApiKey: string | null = null;

export async function getClient(): Promise<WalletHubClient> {
  const state = await walletStore.getState();
  const baseUrl = state.apiBaseUrl || "http://localhost:3005";
  const apiKey = state.apiKey || "";

  if (cachedClient && cachedBaseUrl === baseUrl && cachedApiKey === apiKey) {
    return cachedClient;
  }

  cachedClient = new WalletHubClient({
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
  });
  cachedBaseUrl = baseUrl;
  cachedApiKey = apiKey;
  return cachedClient;
}

export function invalidateClientCache(): void {
  cachedClient = null;
  cachedBaseUrl = null;
  cachedApiKey = null;
}

export function getExternalUserId(): string {
  return "arch-chrome-wallet-user";
}
