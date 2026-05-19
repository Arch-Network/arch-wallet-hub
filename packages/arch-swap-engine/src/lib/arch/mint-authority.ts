import { type NetworkId } from "@/engine-config";
import { type TokenSymbol } from "@/lib/network/config";

/**
 * Resolves the mint authority private key for a (network, token) pair.
 *
 * Each token mint on Arch has its own authority keypair, and testnet and
 * mainnet deployments use distinct authorities — so the env layout is
 * keyed by both network and symbol:
 *
 *   `MINT_AUTHORITY_PRIVATE_KEY_<NETWORK>_<SYMBOL>`
 *
 * e.g. `MINT_AUTHORITY_PRIVATE_KEY_TESTNET_BTC`. The faucet route asserts
 * that `derive_pubkey(private_key)` matches the configured authority
 * pubkey for the active network and refuses to mint otherwise, so a
 * testnet key never silently signs a mainnet mint.
 */

export class MissingMintAuthorityKeyError extends Error {
  readonly symbol: TokenSymbol;
  readonly networkId: NetworkId;
  constructor(symbol: TokenSymbol, networkId: NetworkId) {
    super(
      `Faucet not configured for ${symbol} on ${networkId}: set ${envKeyFor(
        symbol,
        networkId,
      )}.`,
    );
    this.name = "MissingMintAuthorityKeyError";
    this.symbol = symbol;
    this.networkId = networkId;
  }
}

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

function envKeyFor(symbol: TokenSymbol, networkId: NetworkId): string {
  return `MINT_AUTHORITY_PRIVATE_KEY_${networkId.toUpperCase()}_${symbol}`;
}

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Returns the 64-char hex private key for the (network, symbol) mint
 * authority, or `null` if the deployment hasn't configured one. Use
 * `mintAuthorityKey()` (below) when a missing key should hard-fail.
 */
export function tryMintAuthorityKey(
  symbol: TokenSymbol,
  networkId: NetworkId,
): string | null {
  const envKey = envKeyFor(symbol, networkId);
  const candidate = readEnv(envKey);
  if (candidate && !HEX64_RE.test(candidate)) {
    throw new Error(`${envKey} must be 64 hex chars.`);
  }
  return candidate ?? null;
}

export function mintAuthorityKey(
  symbol: TokenSymbol,
  networkId: NetworkId,
): string {
  const key = tryMintAuthorityKey(symbol, networkId);
  if (!key) throw new MissingMintAuthorityKeyError(symbol, networkId);
  return key;
}
