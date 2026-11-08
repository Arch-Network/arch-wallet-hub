import type { BridgeErrorCode, BridgeNetwork } from "./protocol";

export class BridgeError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export function networkName(network: BridgeNetwork): string {
  return network === "mainnet" ? "Bitcoin Mainnet" : "Bitcoin Testnet4";
}

export function shortAddress(address: string): string {
  return address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address;
}

export const bridgeErrors = {
  missing: (label: string) =>
    new BridgeError(
      "PROVIDER_MISSING",
      `${label} isn't installed or is turned off in this browser. Install or enable it, then try again.`,
    ),
  rejected: (label: string) => new BridgeError("USER_REJECTED", `You declined the request in ${label}.`),
  wrongNetwork: (label: string, expected: BridgeNetwork, actual: string) =>
    new BridgeError(
      "WRONG_NETWORK",
      `${label} is on ${actual}. Switch ${label} to ${networkName(expected)} and try again.`,
    ),
  accountMismatch: (label: string, expected: string) =>
    new BridgeError(
      "ACCOUNT_MISMATCH",
      `${label} is using a different account. Switch ${label} back to ${shortAddress(expected)}, or reconnect this wallet.`,
    ),
  notTaproot: (label: string) =>
    new BridgeError(
      "UNSUPPORTED_ADDRESS",
      `Arch needs a Taproot address. In ${label}, switch the address type to Taproot (P2TR), then connect again.`,
    ),
  unsupported: (message: string) => new BridgeError("UNSUPPORTED", message),
};

/** The user declined in their wallet: a choice, not a failure to report. */
export function isUserRejection(err: unknown): boolean {
  return err instanceof BridgeError && err.code === "USER_REJECTED";
}

/**
 * Map a provider's thrown value to a typed error. Xverse's legacy API
 * reports rejection through `onCancel`; UniSat and EIP-1193-style
 * providers throw `{ code: 4001 }`; sats-connect RPC uses -32000.
 */
export function classifyProviderError(err: unknown, label: string): BridgeError {
  if (err instanceof BridgeError) return err;
  const code = (err as { code?: unknown })?.code;
  const message = String((err as { message?: unknown })?.message ?? err ?? "");
  if (code === 4001 || code === -32000 || /reject|denied|cancel/i.test(message)) {
    return bridgeErrors.rejected(label);
  }
  return new BridgeError("PROVIDER_ERROR", message ? `${label}: ${message}` : `${label} returned an error.`);
}
