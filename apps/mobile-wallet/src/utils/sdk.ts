import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { ArchNetwork } from "@arch/wallet-hub-sdk";
import { walletStore } from "../store/wallet-store";
import { secureState } from "../store/secure-state";
import type { NetworkId } from "../store/types";
import { getRandomBytesAsync } from "expo-crypto";

export { deriveArchAccountAddress } from "./crypto";

let cachedClient: WalletHubClient | null = null;
let cachedBaseUrl: string | null = null;
let cachedApiKey: string | null = null;
let cachedNetwork: string | null = null;

function networkIdToArch(n: NetworkId): ArchNetwork {
  return n === "mainnet" ? "mainnet" : "testnet";
}

export async function getClient(): Promise<WalletHubClient> {
  const state = await walletStore.getState();
  const baseUrl = state.apiBaseUrl || "http://localhost:3005";
  const apiKey = state.apiKey || "";
  const network = networkIdToArch(state.network);

  if (
    cachedClient &&
    cachedBaseUrl === baseUrl &&
    cachedApiKey === apiKey &&
    cachedNetwork === network
  ) {
    return cachedClient;
  }

  cachedClient = new WalletHubClient({
    baseUrl,
    network,
    ...(apiKey ? { apiKey } : {}),
  });
  cachedBaseUrl = baseUrl;
  cachedApiKey = apiKey;
  cachedNetwork = network;
  return cachedClient;
}

export function invalidateClientCache(): void {
  cachedClient = null;
  cachedBaseUrl = null;
  cachedApiKey = null;
}

let cachedDeviceId: string | null = null;

/**
 * Get-or-create a per-install identifier. SECURITY:
 *
 *   1. Stored in `expo-secure-store`, not `AsyncStorage`. The device
 *      id is the `externalUserId` the Hub uses to scope every user's
 *      wallets; an attacker who can extract it from a rooted device
 *      backup can ask the Hub to list and import that user's wallets.
 *      Secure storage uses the OS keychain so it is not in the
 *      plaintext backup.
 *
 *   2. Generated with `expo-crypto.getRandomBytesAsync` (16 bytes ->
 *      128 bits). Previous implementation used
 *      `${Date.now()}-${Math.random()}`, which is enumerable for any
 *      install timestamp the attacker can guess.
 */
export async function getExternalUserId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;

  let deviceId = await secureState.getDeviceId();
  if (!deviceId) {
    const bytes = await getRandomBytesAsync(16);
    deviceId = `arch-mobile-${Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;
    await secureState.setDeviceId(deviceId);
  }
  cachedDeviceId = deviceId;
  return deviceId;
}
