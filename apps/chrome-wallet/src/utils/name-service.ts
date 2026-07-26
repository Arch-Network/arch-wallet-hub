import {
  AnsClient,
  hexToBytes,
  loadTestnetManifest,
  type AnsTransport,
} from "@arch-network/ans-sdk";
import bs58 from "bs58";
import type { NetworkId } from "../state/types";
import { detectBtcNetwork } from "./addressNetwork";
import { getIndexer } from "./indexer";

export interface NameResolution {
  address: string;
  source: "literal" | "arch-name";
  name?: string;
}

type ResolverClient = Pick<AnsClient, "resolveOwner" | "resolvePrimary">;

export interface NameServiceOptions {
  network: NetworkId;
  client?: ResolverClient;
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value.map(Number));
  if (typeof value === "string") return hexToBytes(value);
  return new Uint8Array();
}

function createHubTransport(): AnsTransport {
  return {
    async readAccountInfo(pubkey) {
      const indexer = await getIndexer();
      const key = typeof pubkey === "string" ? pubkey : Array.from(pubkey);
      const account = await indexer.rpc<{
        data?: unknown;
        owner?: unknown;
        lamports?: number;
        is_executable?: boolean;
      } | null>("read_account_info", [key]);
      if (!account) return null;
      return {
        data: toBytes(account.data),
        owner: toBytes(account.owner),
        lamports: account.lamports ?? 0,
        isExecutable: Boolean(account.is_executable),
      };
    },
    async getCurrentSlot() {
      const indexer = await getIndexer();
      try {
        return BigInt(await indexer.rpc<number | string>("get_slot", []));
      } catch {
        return BigInt(await indexer.rpc<number | string>("get_block_count", []));
      }
    },
    async getBestBlockHash() {
      const indexer = await getIndexer();
      return toBytes(await indexer.rpc<string | number[]>("get_best_block_hash", []));
    },
    async sendTransaction() {
      throw new Error("ANS mutations are not supported by the wallet resolver");
    },
    async getProcessedTransaction() {
      throw new Error("ANS mutations are not supported by the wallet resolver");
    },
  };
}

let testnetClient: AnsClient | null = null;

function getTestnetClient(): AnsClient {
  if (!testnetClient) {
    testnetClient = new AnsClient(loadTestnetManifest(), createHubTransport());
  }
  return testnetClient;
}

export function isArchName(input: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.arch$/i.test(input.trim());
}

export function isArchAddress(input: string): boolean {
  try {
    return bs58.decode(input.trim()).length === 32;
  } catch {
    return false;
  }
}

export async function resolveName(
  input: string,
  options: NameServiceOptions,
): Promise<NameResolution | null> {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (detectBtcNetwork(trimmed)) return { address: trimmed, source: "literal" };
  if (isArchAddress(trimmed)) return { address: trimmed, source: "literal" };
  if (!isArchName(trimmed) || options.network === "mainnet") return null;

  try {
    const owner = await (options.client ?? getTestnetClient()).resolveOwner(trimmed);
    return {
      address: bs58.encode(owner),
      source: "arch-name",
      name: trimmed.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export async function resolvePrimaryName(
  address: string,
  options: NameServiceOptions,
): Promise<string | null> {
  if (options.network === "mainnet" || !isArchAddress(address)) return null;
  try {
    return await (options.client ?? getTestnetClient()).resolvePrimary(bs58.decode(address));
  } catch {
    return null;
  }
}
