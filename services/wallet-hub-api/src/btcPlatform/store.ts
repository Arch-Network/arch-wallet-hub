import type { BtcPlatformClient } from "./client.js";

let btcPlatformClient: BtcPlatformClient | null = null;

export function setBtcPlatformClient(client: BtcPlatformClient | null) {
  btcPlatformClient = client;
}

export function getBtcPlatformClient(): BtcPlatformClient | null {
  return btcPlatformClient;
}
