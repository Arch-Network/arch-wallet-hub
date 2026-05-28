/**
 * Helpers for building watch-only WalletAccount records from a
 * user-supplied taproot address.
 *
 * Why taproot only:
 *
 *   - The Arch network identifies accounts by their untweaked x-only
 *     public key. We can recover that key only from a P2TR (bc1p…)
 *     address, because the bech32m payload IS the x-only key.
 *   - Non-taproot address types (P2PKH / P2SH / P2WPKH) don't reveal
 *     the public key until a spend reveals it on-chain. Importing one
 *     as watch-only would leave its Arch address unresolvable until
 *     then, which would make the wallet's per-account view broken in
 *     ways that are hard to communicate in the UI.
 *
 * Users with a non-taproot address that they want to monitor can
 * still see balances on a Bitcoin block explorer; we'd rather refuse
 * up-front than ship a partial-feature watch account.
 */

import { address as btcAddress } from "bitcoinjs-lib";
import { deriveArchAccountAddress } from "./sdk";
import type { NetworkId, WalletAccount } from "../state/types";

export class InvalidWatchAddressError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "InvalidWatchAddressError";
  }
}

/**
 * Extract the 32-byte x-only public key from a P2TR bech32m address.
 * Throws InvalidWatchAddressError on anything that isn't a v1
 * witness program with a 32-byte payload.
 *
 * (This is the same decode as `xOnlyPubkeyFromTaprootAddress` in
 * `utils/bip322.ts` but lives here so the watch-only flow doesn't
 * pull in the rest of the BIP-322 helper graph.)
 */
function xOnlyPubkeyFromTaproot(addr: string): Uint8Array {
  let decoded;
  try {
    decoded = btcAddress.fromBech32(addr);
  } catch {
    throw new InvalidWatchAddressError(
      "Watch-only currently supports taproot (bc1p… / tb1p…) addresses only.",
    );
  }
  if (decoded.version !== 1 || decoded.data.length !== 32) {
    throw new InvalidWatchAddressError(
      "Watch-only currently supports taproot (bc1p… / tb1p…) addresses only.",
    );
  }
  return new Uint8Array(decoded.data);
}

/**
 * Validate that the taproot address's HRP matches the wallet's
 * current network. Mixing mainnet `bc1p…` and testnet `tb1p…`
 * across networks is the canonical source of "where did my balance
 * go?" support tickets, so we refuse rather than silently
 * accept-and-display-zero.
 */
function assertNetworkHrp(addr: string, network: NetworkId): void {
  const lower = addr.toLowerCase();
  const expectMainnet = network === "mainnet";
  if (expectMainnet && !lower.startsWith("bc1p")) {
    throw new InvalidWatchAddressError(
      "This is a testnet taproot address; switch the wallet to Testnet4 before adding it.",
    );
  }
  if (!expectMainnet && !lower.startsWith("tb1p")) {
    throw new InvalidWatchAddressError(
      "This is a mainnet taproot address; switch the wallet to Mainnet before adding it.",
    );
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build a `WalletAccount` record for a watch-only taproot address.
 * Callers pass it to `walletStore.addAccount`.
 *
 * Watch accounts populate `publicKeyHex` / `archAddress` deterministically
 * from the address; `turnkeyResourceId` and `organizationId` are left
 * as empty strings -- the wallet-store's iterators key off `kind` so
 * those fields are never read for watch accounts in practice. We keep
 * them present (not optional) to avoid widening `WalletAccount` and
 * forcing optional-chain rewrites at every read site.
 */
export function buildWatchAccount(opts: {
  taprootAddress: string;
  label: string;
  network: NetworkId;
}): WalletAccount {
  const trimmedLabel = opts.label.trim();
  if (!trimmedLabel) {
    throw new InvalidWatchAddressError("Label is required for watch-only wallets.");
  }
  assertNetworkHrp(opts.taprootAddress, opts.network);
  const xOnly = xOnlyPubkeyFromTaproot(opts.taprootAddress);
  const publicKeyHex = toHex(xOnly);
  const archAddress = deriveArchAccountAddress(publicKeyHex);

  return {
    id: `watch-${publicKeyHex.slice(0, 16)}`,
    label: trimmedLabel,
    btcAddress: opts.taprootAddress,
    publicKeyHex,
    archAddress,
    kind: "watch",
    turnkeyResourceId: "",
    organizationId: "",
    authMethod: "watch",
    createdAt: Date.now(),
  };
}
