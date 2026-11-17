/**
 * Pure helpers for Turnkey seed export and seed import.
 *
 * The secret itself never passes through these functions. Export and
 * import bundles are opaque HPKE ciphertext; the plaintext is decrypted
 * only inside Turnkey's iframe.
 */
import type { NetworkId, WalletAccount } from "../state/types";
import { isTurnkeyAccount } from "../state/types";

export interface BitcoinAccountSpec {
  path: string;
  addressFormat:
    | "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR"
    | "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR";
}

/** First BIP86 Taproot address. Same path the Hub uses when it creates a wallet. */
export function bitcoinTaprootAccount(network: NetworkId): BitcoinAccountSpec {
  if (network === "mainnet") {
    return {
      path: "m/86'/0'/0'/0/0",
      addressFormat: "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR",
    };
  }
  return {
    path: "m/86'/1'/0'/0/0",
    addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR",
  };
}

export function walletIdForAddress(
  groups: { walletId: string; accounts: { address?: string }[] }[],
  address: string,
): string | null {
  for (const group of groups) {
    if (group.accounts.some((account) => account.address === address)) {
      return group.walletId;
    }
  }
  return null;
}

/**
 * The Turnkey account an imported seed is stored in. Prefer the active
 * passkey or email wallet, since that is the login the user expects to
 * approve with. Fall back to the first such wallet.
 */
export function importHostAccount(
  accounts: WalletAccount[],
  activeAccountId: string | null,
): WalletAccount | null {
  const active = accounts.find((account) => account.id === activeAccountId);
  if (active && isTurnkeyAccount(active)) return active;
  return accounts.find((account) => isTurnkeyAccount(account)) ?? null;
}

export interface TurnkeyActivity {
  id: string;
  status: string;
  result?: Record<string, unknown> | null;
}

export function readResultString(
  result: Record<string, unknown> | null | undefined,
  resultKey: string,
  field: string,
): string {
  const block = result?.[resultKey];
  if (!block || typeof block !== "object") {
    throw new Error("Turnkey returned an unexpected result");
  }
  const value = (block as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Turnkey returned an unexpected result");
  }
  return value;
}

export function readImportedWallet(
  result: Record<string, unknown> | null | undefined,
): { walletId: string; address: string } {
  const walletId = readResultString(result, "importWalletResult", "walletId");
  const block = result?.importWalletResult;
  const addresses =
    block && typeof block === "object"
      ? (block as Record<string, unknown>).addresses
      : undefined;
  const address = Array.isArray(addresses) ? addresses[0] : undefined;
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("Turnkey did not return an address for the imported wallet");
  }
  return { walletId, address };
}
