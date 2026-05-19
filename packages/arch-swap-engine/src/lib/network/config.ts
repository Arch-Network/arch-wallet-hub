// Per-network configuration + derived helpers.
//
// Type definitions live in `lib/network/types.ts`; per-environment data
// lives in `lib/network/testnet.ts` and `lib/network/mainnet.ts`.
//
// **Do not** read a module-level "active" config here — network selection
// is request-scoped:
//   - Server: `getServerNetworkConfig()` in `lib/network/server.ts`
//   - Client: `useNetworkConfig()` in `lib/network/context.tsx`

import { hexToBytes } from "@/lib/arch/hex";
import { MAINNET_CONFIG } from "@/lib/network/mainnet";
import { TESTNET_CONFIG } from "@/lib/network/testnet";
import type {
  Curator,
  LendingMarket,
  NetworkConfig,
  NetworkId,
  TokenInfo,
  TokenSymbol,
} from "@/lib/network/types";

export type {
  Curator,
  CuratorKey,
  LendingMarket,
  NetworkConfig,
  NetworkId,
  PropAmmDeployment,
  TokenInfo,
  TokenSymbol,
} from "@/lib/network/types";

const CONFIGS: Record<NetworkId, NetworkConfig> = {
  testnet: TESTNET_CONFIG,
  mainnet: MAINNET_CONFIG,
};

/** Static lookup — no cookie/env resolution. */
export function getNetworkConfig(id: NetworkId): NetworkConfig {
  return CONFIGS[id];
}

/** Token symbols configured on `config`. */
export function getTokenSymbols(config: NetworkConfig): TokenSymbol[] {
  return Object.keys(config.tokens) as TokenSymbol[];
}

/**
 * Resolve `TokenInfo` for a symbol on `config`.
 * Throws if the symbol isn't configured on that network.
 */
export function getToken(symbol: TokenSymbol, config: NetworkConfig): TokenInfo {
  const token = config.tokens[symbol];
  if (!token) {
    throw new Error(
      `Token "${symbol}" is not configured on the active network.`,
    );
  }
  return token;
}

/** Lowercase mint hex for `symbol` on `config`, or `null` if unknown. */
export function mintHexForSymbol(
  symbol: string,
  config: NetworkConfig,
): string | null {
  const token = config.tokens[symbol as TokenSymbol];
  return token ? token.mint.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Program ID bytes (per-network)
// ---------------------------------------------------------------------------

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const PROGRAM_ID_PLACEHOLDER_HEX = "f".repeat(64);
const _placeholderLogged = new Set<string>();

function deriveProgramIdBytes(
  value: string,
  label: string,
  networkId: NetworkId,
): Uint8Array {
  if (HEX64_RE.test(value)) {
    return hexToBytes(value);
  }
  const logKey = `${networkId}:${label}`;
  if (!_placeholderLogged.has(logKey)) {
    _placeholderLogged.add(logKey);
    console.warn(
      `[network-config] ${label} is not configured on ${networkId} ` +
        `(got "${value}"). Substituting a sentinel — calls that hit this ` +
        `program will fail at the RPC layer.`,
    );
  }
  return hexToBytes(PROGRAM_ID_PLACEHOLDER_HEX);
}

/** Map a `NetworkConfig` instance back to its id (reference equality). */
export function resolveNetworkId(config: NetworkConfig): NetworkId {
  if (config === MAINNET_CONFIG) return "mainnet";
  if (config === TESTNET_CONFIG) return "testnet";
  return config.archRpcUrl.includes("mainnet.arch") ? "mainnet" : "testnet";
}

export function getClammProgramIdBytes(config: NetworkConfig): Uint8Array {
  return deriveProgramIdBytes(
    config.clammProgramId,
    "clammProgramId",
    resolveNetworkId(config),
  );
}

export function getLendingProgramIdBytes(config: NetworkConfig): Uint8Array {
  return deriveProgramIdBytes(
    config.lendingProgramId,
    "lendingProgramId",
    resolveNetworkId(config),
  );
}

// ---------------------------------------------------------------------------
// Lending market lookups (per-network)
// ---------------------------------------------------------------------------

function marketsByHexFor(config: NetworkConfig): Record<string, LendingMarket> {
  return Object.fromEntries(
    config.lendingMarkets.map((m) => [m.address.toLowerCase(), m]),
  );
}

export function lendingMarketByHex(
  hex: string,
  config: NetworkConfig,
): LendingMarket | null {
  return marketsByHexFor(config)[hex.toLowerCase()] ?? null;
}

export function curatorForMarketHex(
  hex: string,
  config: NetworkConfig,
): Curator | null {
  const market = lendingMarketByHex(hex, config);
  return market ? config.curators[market.curator] : null;
}

const isValidMarketHex = (s: string) => /^[0-9a-fA-F]{64}$/.test(s);

export function getLendingMarkets(config: NetworkConfig): LendingMarket[] {
  return config.lendingMarkets.filter((m) => isValidMarketHex(m.address));
}

export function getLendingMarketAddresses(config: NetworkConfig): string[] {
  return getLendingMarkets(config).map((m) => m.address);
}
