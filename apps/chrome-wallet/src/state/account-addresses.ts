import type {
  AccountAddress,
  AddressPurpose,
  BtcAddressType,
  NetworkId,
  WalletAccount,
} from "./types";
import { detectBtcNetwork, reEncodeTaprootAddress } from "../utils/addressNetwork";

export interface ResolvedAddresses {
  /** Taproot address carrying the Arch identity; Arch actions sign with it. */
  identity: string | null;
  /** Where ordinary BTC is received. */
  payment: string | null;
  /** Where inscriptions and runes are received. */
  ordinals: string | null;
  /** Unique addresses whose balances belong to this account on the network. */
  all: string[];
  /** Records for the network, deduplicated, purposes merged. */
  records: AccountAddress[];
  /**
   * - `network-not-linked`: the provider never gave us an address on this network.
   * - `payment-not-linked`: linked before payment addresses were stored; reconnect to add it.
   */
  gap?: "network-not-linked" | "payment-not-linked";
}

export function addressTypeOf(address: string): BtcAddressType {
  const lower = address.toLowerCase();
  if (/^(bc|tb|bcrt)1p/.test(lower)) return "p2tr";
  if (/^(bc|tb|bcrt)1q/.test(lower)) return lower.length <= 44 ? "p2wpkh" : "unknown";
  if (/^[23]/.test(address)) return "p2sh";
  if (/^[1mn]/.test(address)) return "p2pkh";
  return "unknown";
}

/**
 * Merge records that share an address so a payment+ordinals address
 * that happens to be one address is counted once.
 */
export function dedupeAddresses(records: AccountAddress[]): AccountAddress[] {
  const byKey = new Map<string, AccountAddress>();
  for (const r of records) {
    const key = `${r.network}:${r.address}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...r, purposes: [...new Set(r.purposes)] });
      continue;
    }
    existing.purposes = [...new Set([...existing.purposes, ...r.purposes])];
    existing.chainVerified = existing.chainVerified && r.chainVerified;
    existing.publicKeyHex ??= r.publicKeyHex;
  }
  return [...byKey.values()];
}

function withPurpose(records: AccountAddress[], purpose: AddressPurpose): string | null {
  return records.find((r) => r.purposes.includes(purpose))?.address ?? null;
}

function resolveFromRecords(account: WalletAccount, records: AccountAddress[]): ResolvedAddresses {
  if (records.length === 0) {
    return { identity: null, payment: null, ordinals: null, all: [], records, gap: "network-not-linked" };
  }
  const identity =
    records.find((r) => r.address === account.btcAddress)?.address ??
    records.find((r) => r.addressType === "p2tr")?.address ??
    null;
  return {
    identity,
    payment: withPurpose(records, "payment"),
    ordinals: withPurpose(records, "ordinals"),
    all: records.map((r) => r.address),
    records,
  };
}

/**
 * Which Bitcoin addresses belong to `account` on `network`.
 *
 * Native (Arch-held) and watch accounts re-encode their Taproot address,
 * because the same key spends it on either network. External accounts
 * only ever use addresses the provider returned for that network.
 */
export function resolveAccountAddresses(account: WalletAccount, network: NetworkId): ResolvedAddresses {
  if (account.kind !== "external") {
    const address = reEncodeTaprootAddress(account.btcAddress, network);
    const record: AccountAddress = {
      address,
      publicKeyHex: account.publicKeyHex || undefined,
      purposes: ["payment", "ordinals"],
      network,
      addressType: addressTypeOf(address),
      chainVerified: true,
    };
    return { identity: address, payment: address, ordinals: address, all: [address], records: [record] };
  }

  if (account.addresses?.length) {
    return resolveFromRecords(
      account,
      dedupeAddresses(account.addresses.filter((r) => r.network === network)),
    );
  }

  // Linked before per-purpose addresses were stored: all we know is the
  // Taproot identity address, on the network its encoding implies.
  if (detectBtcNetwork(account.btcAddress) !== network) {
    return { identity: null, payment: null, ordinals: null, all: [], records: [], gap: "network-not-linked" };
  }
  const singleAddressProvider = account.externalProvider === "unisat";
  const record: AccountAddress = {
    address: account.btcAddress,
    publicKeyHex: account.publicKeyHex || undefined,
    purposes: singleAddressProvider ? ["payment", "ordinals"] : ["ordinals"],
    network,
    addressType: addressTypeOf(account.btcAddress),
    chainVerified: false,
  };
  const resolved = resolveFromRecords(account, [record]);
  return singleAddressProvider ? resolved : { ...resolved, gap: "payment-not-linked" };
}

/** The Taproot address Arch actions and dapps see on `network`, or null if the account has none there. */
export function identityAddress(account: WalletAccount, network: NetworkId): string | null {
  return resolveAccountAddresses(account, network).identity;
}
