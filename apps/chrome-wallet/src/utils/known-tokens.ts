/**
 * Registry of mints whose metadata we trust without hitting the indexer
 * or APL RPC. Sources its data from `@arch/swap-engine`'s network
 * configs (TESTNET_CONFIG, MAINNET_CONFIG) so there's exactly one
 * authoritative place to register a token's name / symbol / icon /
 * decimals — adding to a swap pool automatically lights up its display
 * everywhere in the wallet.
 *
 * Why we need this on top of the indexer:
 *   - APL tokens don't have on-chain Metaplex-style metadata, so a
 *     freshly-minted USDC or BTC ATA shows up as a generic "APL Token"
 *     until the indexer's offchain registry is updated (manually,
 *     centrally).
 *   - The arch-swap mints are first-party knowledge of the wallet:
 *     they're the tokens the user is meant to swap. Treating them as
 *     "unknown" is a discoverability bug; recognizing them means the
 *     Tokens page reads "Bitcoin / USD Coin" instead of base58 noise.
 *
 * Address-form gotcha:
 *   - The engine stores mints as 64-char hex.
 *   - The indexer returns mints as base58 ("ByGq...4DTz").
 *   We index by both forms so callers don't have to know which one
 *   they're holding. Case is normalized at registration; queries
 *   are case-sensitive on base58 (per Bitcoin convention) and
 *   case-insensitive on hex.
 */

import bs58 from "bs58";
import { TESTNET_CONFIG, MAINNET_CONFIG, type NetworkConfig, type TokenInfo } from "@arch/swap-engine";

import type { NetworkId } from "../state/types";

export interface KnownTokenMeta {
  /** Display name, e.g. "Bitcoin". */
  name: string;
  /** Short ticker, e.g. "BTC". */
  symbol: string;
  /** Decimals — authoritative; overrides any indexer-supplied value. */
  decimals: number;
  /** Asset path relative to the extension's public dir, e.g. "/btc.png".
   *  May be `undefined` if no icon is shipped; UI components fall back
   *  to a glyph in that case. */
  icon?: string;
  /** Mint in both forms, for callers that want to display alongside. */
  mintHex: string;
  mintBase58: string;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error(`Expected 32-byte mint hex, got ${clean.length / 2} bytes`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Wallet-only display overrides for engine-supplied token metadata.
 *
 * The engine treats `symbol` as a strict union type ("BTC" | "USDC" |
 * "USDT") because it's used as a routing key for pool lookups. That
 * works at the protocol layer, but it leaks into UI naming: the
 * APL-wrapped asset is *not* native L1 BTC, and showing both as plain
 * "BTC" confuses users that hold sats on the Bitcoin side AND
 * wrapped-BTC on Arch.
 *
 * Keys: 64-char lowercase hex mint addresses. Values: the (symbol,
 * name) the wallet should show in every UI surface. The engine
 * continues to refer to the asset by its canonical key for
 * quote/routing purposes.
 */
const DISPLAY_OVERRIDES: Record<string, { symbol: string; name: string }> = {
  // Testnet wrapped BTC
  "726179cf49b6dc407c1438cec98815d92277b625b09de81818f5f3a57989f1f1": {
    symbol: "aBTC",
    name: "Arch Bitcoin",
  },
  // Mainnet wrapped BTC
  "225b03d6f9e05fd834cd18906b019fb46372544b0eeb9f6f8b615472467d46b0": {
    symbol: "aBTC",
    name: "Arch Bitcoin",
  },
  // Mainnet Arch USD
  "aec8ca1598d74bc27721536f1a88b5648740bc6a856546a0a47817ff7fe7437c": {
    symbol: "aUSD",
    name: "Arch USD",
  },
};

function applyDisplayOverride(mintHex: string, base: { symbol: string; name: string }) {
  const override = DISPLAY_OVERRIDES[mintHex];
  return override ? { ...base, ...override } : base;
}

function buildRegistry(
  config: NetworkConfig,
): { byHex: Map<string, KnownTokenMeta>; byBase58: Map<string, KnownTokenMeta> } {
  const byHex = new Map<string, KnownTokenMeta>();
  const byBase58 = new Map<string, KnownTokenMeta>();
  for (const token of Object.values(config.tokens) as TokenInfo[]) {
    if (!token?.mint) continue;
    let base58: string;
    try {
      base58 = bs58.encode(hexToBytes(token.mint));
    } catch {
      // Skip malformed entries silently — fail-open so a config typo
      // doesn't take down the whole UI.
      continue;
    }
    const mintHex = token.mint.toLowerCase();
    const display = applyDisplayOverride(mintHex, {
      symbol: token.symbol,
      name: token.name,
    });
    const meta: KnownTokenMeta = {
      name: display.name,
      symbol: display.symbol,
      decimals: token.decimals,
      icon: token.icon,
      mintHex,
      mintBase58: base58,
    };
    byHex.set(meta.mintHex, meta);
    byBase58.set(base58, meta);
  }
  return { byHex, byBase58 };
}

// Memoize per network so the bs58 conversion runs once at module load.
const REGISTRY: Record<NetworkId, ReturnType<typeof buildRegistry>> = {
  testnet4: buildRegistry(TESTNET_CONFIG),
  mainnet: buildRegistry(MAINNET_CONFIG),
};

/**
 * Resolve metadata for a known mint. Accepts either form:
 *   - 64-char hex (case-insensitive)
 *   - base58 string (case-sensitive — the indexer always returns this form)
 *
 * Returns `null` when the mint isn't in the registry; callers should
 * then fall back to indexer / RPC enrichment.
 */
export function lookupKnownToken(
  mint: string,
  network: NetworkId,
): KnownTokenMeta | null {
  const reg = REGISTRY[network];
  if (!reg || !mint) return null;
  // Distinguish hex (64 lowercase-or-mixed hex chars) from base58. We
  // probe both maps; the constraints don't overlap in practice but the
  // double check is cheap and removes one decision the caller would
  // otherwise have to make.
  const normalizedHex = mint.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(normalizedHex)) {
    const hit = reg.byHex.get(normalizedHex);
    if (hit) return hit;
  }
  return reg.byBase58.get(mint) ?? null;
}

/**
 * Enumerate every known token for a network. Useful for "supported
 * assets" pickers / empty-state hero illustrations.
 */
export function listKnownTokens(network: NetworkId): KnownTokenMeta[] {
  return Array.from(REGISTRY[network]?.byHex.values() ?? []);
}

/**
 * Apply the wallet's display overrides to an engine-supplied
 * (symbol, name) pair given a hex mint. Returns the input unchanged if
 * the mint isn't in the overrides table.
 *
 * Use this from surfaces that already hold an engine `TokenInfo`
 * (e.g. the Swap UI) instead of round-tripping through the registry.
 */
export function applyDisplayOverridesByMintHex<T extends { symbol: string; name: string }>(
  base: T,
  mintHex: string | null | undefined,
): T {
  if (!mintHex) return base;
  const key = mintHex.toLowerCase();
  const override = DISPLAY_OVERRIDES[key];
  return override ? { ...base, ...override } : base;
}
