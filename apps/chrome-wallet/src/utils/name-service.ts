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

/** Public ANS manager SPA. Marketplace / register / manage live here. */
export const ANS_MANAGER_ORIGIN = "https://id.arch.network";

/**
 * ANS is live on Arch testnet today. Mainnet stays off until a mainnet
 * manifest ships in `@arch-network/ans-sdk` — flip this helper (and add
 * `loadMainnetManifest`) rather than scattering network checks.
 */
export function isAnsEnabledForNetwork(network: NetworkId): boolean {
  return network === "testnet4";
}

export type AnsManagerPath =
  | "explore"
  | "manage"
  | "names"
  | "register"
  | { view: string };

export function ansManagerUrl(path: AnsManagerPath = "explore"): string {
  if (typeof path === "object") {
    const name = path.view.trim().toLowerCase();
    return `${ANS_MANAGER_ORIGIN}/#/view?name=${encodeURIComponent(name)}`;
  }
  switch (path) {
    case "manage":
      return `${ANS_MANAGER_ORIGIN}/#/manage`;
    case "names":
      return `${ANS_MANAGER_ORIGIN}/#/names`;
    case "register":
      return `${ANS_MANAGER_ORIGIN}/#/register`;
    case "explore":
    default:
      return `${ANS_MANAGER_ORIGIN}/#/explore`;
  }
}

/** Open the ANS manager in a browser tab (extension) or new window (fallback). */
export async function openAnsManager(path: AnsManagerPath = "explore"): Promise<void> {
  const url = ansManagerUrl(path);
  try {
    const chromeApi = (
      globalThis as {
        chrome?: { tabs?: { create?: (opts: { url: string }) => Promise<unknown> | unknown } };
      }
    ).chrome;
    if (chromeApi?.tabs?.create) {
      await chromeApi.tabs.create({ url });
      return;
    }
  } catch {
    /* fall through to window.open */
  }
  window.open(url, "_blank", "noopener,noreferrer");
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

/**
 * Resolve the ANS client for a wallet network. Today only testnet is
 * configured; callers should gate with {@link isAnsEnabledForNetwork}.
 */
function getClientForNetwork(network: NetworkId): AnsClient | null {
  if (!isAnsEnabledForNetwork(network)) return null;
  return getTestnetClient();
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
  if (!isArchName(trimmed) || !isAnsEnabledForNetwork(options.network)) return null;

  try {
    const client = options.client ?? getClientForNetwork(options.network);
    if (!client) return null;
    const owner = await client.resolveOwner(trimmed);
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
  if (!isAnsEnabledForNetwork(options.network) || !isArchAddress(address)) return null;
  try {
    const client = options.client ?? getClientForNetwork(options.network);
    if (!client) return null;
    return await client.resolvePrimary(bs58.decode(address));
  } catch {
    return null;
  }
}
