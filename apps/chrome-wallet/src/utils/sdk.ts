import { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { ArchNetwork } from "@arch/wallet-hub-sdk";
import bs58 from "bs58";
import { walletStore } from "../state/wallet-store";
import type { NetworkId } from "../state/types";

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

  if (cachedClient && cachedBaseUrl === baseUrl && cachedApiKey === apiKey && cachedNetwork === network) {
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

export function getExternalUserId(): string {
  return "arch-chrome-wallet-user";
}

/**
 * Derive the Arch account address (base58) from a compressed (33-byte hex) or
 * x-only (32-byte hex) public key. The Arch node treats account_keys as BIP-86
 * internal keys, so the identity MUST be the untweaked x-only key.
 */
export function deriveArchAccountAddress(publicKeyHex: string): string {
  const xOnlyHex = publicKeyHex.length === 66
    ? publicKeyHex.slice(2)
    : publicKeyHex;
  const buf = new Uint8Array(xOnlyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  return bs58.encode(buf);
}
