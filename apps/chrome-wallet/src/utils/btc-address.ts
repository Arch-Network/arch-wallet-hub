import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "@bitcoinerlab/secp256k1";
import type { NetworkId } from "../state/types";

/** Shown when a recipient does not decode to a script on the active network. */
export const INVALID_BTC_ADDRESS_MESSAGE = "That isn't a valid Bitcoin address.";

let eccReady = false;
function ensureEccLib() {
  if (!eccReady) {
    bitcoin.initEccLib(ecc);
    eccReady = true;
  }
}

/**
 * Drop whitespace, including the groups of four the receive screen
 * inserts for display. A pasted `bc1p qwer ...` is the same address
 * as `bc1pqwer...`; bitcoinjs will not decode the spaced form.
 */
export function normalizeBtcAddress(input: string): string {
  return input.replace(/[\s\u200B-\u200D\uFEFF]+/g, "");
}

function libNetwork(network: NetworkId): bitcoin.Network {
  return network === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
}

export type BtcAddressCheck = {
  ok: boolean;
  address: string;
  reason: "empty" | "wrong-network" | "invalid" | null;
};

/**
 * Checksum-validate a Bitcoin address for `network`. Empty input is
 * `empty` so the form can stay quiet. A string that decodes on the
 * other network is `wrong-network` rather than a generic failure.
 */
export function checkBtcAddress(input: string, network: NetworkId): BtcAddressCheck {
  ensureEccLib();
  const address = normalizeBtcAddress(input);
  if (!address) return { ok: false, address, reason: "empty" };
  try {
    bitcoin.address.toOutputScript(address, libNetwork(network));
    return { ok: true, address, reason: null };
  } catch {
    const other = libNetwork(network === "mainnet" ? "testnet4" : "mainnet");
    try {
      bitcoin.address.toOutputScript(address, other);
      return { ok: false, address, reason: "wrong-network" };
    } catch {
      return { ok: false, address, reason: "invalid" };
    }
  }
}

/**
 * True once a failed check is no longer just a half-typed address.
 * P2WPKH is 42 characters, P2TR/P2WSH are 62, legacy is at least 26.
 */
export function btcAddressReady(address: string): boolean {
  const a = address.toLowerCase();
  if (a.startsWith("bc1p") || a.startsWith("tb1p") || a.startsWith("bcrt1p")) {
    return address.length >= 62;
  }
  if (a.startsWith("bc1") || a.startsWith("tb1") || a.startsWith("bcrt1")) {
    return address.length >= 42;
  }
  return address.length >= 26;
}

/**
 * Normalize `toAddress` and require it to decode on `network`.
 * Callers use this before fetching UTXOs so a bad paste fails closed
 * with a wallet message instead of bitcoinjs's "has no matching Script".
 */
export function requireRecipientAddress(toAddress: string, network: bitcoin.Network): string {
  ensureEccLib();
  const address = normalizeBtcAddress(toAddress);
  try {
    bitcoin.address.toOutputScript(address, network);
    return address;
  } catch {
    const err = new Error(INVALID_BTC_ADDRESS_MESSAGE);
    (err as { code?: string }).code = "INVALID_ADDRESS";
    throw err;
  }
}
