/**
 * Xverse, via sats-connect's legacy callback API (`getAddress`,
 * `signMessage`, `signTransaction`).
 *
 * Why legacy: sats-connect's `request("wallet_connect", …)` dispatches
 * through `BitcoinProvider.request`, which registers but never resolves
 * on some Xverse builds — the approval popup never opens. The legacy
 * calls dispatch through `.connect()` / `.signMessage()` /
 * `.signTransaction()`, which Xverse answers. Keep this path until the
 * affected builds pass regression tests.
 *
 * Xverse separates a payment address (P2SH-P2WPKH or P2WPKH) from an
 * ordinals address (P2TR); both are returned and stored exactly as given.
 */
import {
  AddressPurpose,
  BitcoinNetworkType,
  MessageSigningProtocols,
  getAddress,
  request,
  signMessage as xverseSignMessage,
  signTransaction as xverseSignTransaction,
  type Address,
  type GetAddressResponse,
  type SignTransactionResponse,
} from "sats-connect";
import { addressTypeOf } from "../../state/account-addresses";
import type { BtcAddressType } from "../../state/types";
import { detectBtcNetwork } from "../../utils/addressNetwork";
import { BridgeError, bridgeErrors } from "./errors";
import { waitForProvider, within } from "./detect";
import type { BridgeAddress, BridgeConnectResult, BridgeNetwork, BridgeRequest } from "./protocol";

const LABEL = "Xverse";
const NETWORK_READ_TIMEOUT_MS = 1500;
const KNOWN_TYPES: BtcAddressType[] = ["p2tr", "p2wpkh", "p2sh", "p2pkh"];

function networkType(network: BridgeNetwork): BitcoinNetworkType {
  // With Testnet4 requested, Xverse shows its own "Mismatched Network"
  // prompt when set elsewhere. Mapping to Testnet instead hangs silently.
  return network === "mainnet" ? BitcoinNetworkType.Mainnet : BitcoinNetworkType.Testnet4;
}

function installedProvider(): unknown {
  const w = window as { XverseProviders?: { BitcoinProvider?: unknown }; BitcoinProvider?: unknown };
  return w.XverseProviders?.BitcoinProvider || w.BitcoinProvider;
}

async function ensureInstalled(): Promise<void> {
  if (!(await waitForProvider(installedProvider))) throw bridgeErrors.missing(LABEL);
}

function promisify<T>(fn: (opts: any) => Promise<void>, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn({
      payload,
      onFinish: (response: T) => resolve(response),
      onCancel: () => reject(bridgeErrors.rejected(LABEL)),
    }).catch(reject);
  });
}

/**
 * Xverse's own report of its Bitcoin network, or null when it can't be
 * read (no permission yet, or a build whose `request` never resolves).
 */
async function reportedNetwork(): Promise<string | null> {
  try {
    const res = await within(request("wallet_getNetwork", null), NETWORK_READ_TIMEOUT_MS);
    return res?.status === "success" ? res.result.bitcoin.name : null;
  } catch {
    return null;
  }
}

/** Fail on a network Xverse reports, or an address encoded for the other network family. */
async function assertNetwork(network: BridgeNetwork, addresses: string[]): Promise<boolean> {
  for (const address of addresses) {
    if (detectBtcNetwork(address) !== network) {
      throw bridgeErrors.wrongNetwork(LABEL, network, network === "mainnet" ? "a test network" : "Mainnet");
    }
  }
  const reported = await reportedNetwork();
  if (reported === null) return false;
  if (reported !== networkType(network)) throw bridgeErrors.wrongNetwork(LABEL, network, reported);
  return true;
}

export function toBridgeAddress(a: Address): BridgeAddress | null {
  if (a.purpose !== AddressPurpose.Payment && a.purpose !== AddressPurpose.Ordinals) return null;
  if (!a.address) return null;
  const reported = a.addressType as string;
  return {
    address: a.address,
    publicKeyHex: a.publicKey || "",
    purposes: [a.purpose === AddressPurpose.Payment ? "payment" : "ordinals"],
    addressType: KNOWN_TYPES.includes(reported as BtcAddressType)
      ? (reported as BtcAddressType)
      : addressTypeOf(a.address),
  };
}

export async function xverseConnect(network: BridgeNetwork): Promise<BridgeConnectResult> {
  await ensureInstalled();
  const response = await promisify<GetAddressResponse>(getAddress, {
    purposes: [AddressPurpose.Payment, AddressPurpose.Ordinals],
    message: "Connect to Arch Wallet",
    network: { type: networkType(network) },
  });
  const addresses = (response?.addresses ?? []).map(toBridgeAddress).filter((a): a is BridgeAddress => a !== null);
  const identity =
    addresses.find((a) => a.purposes.includes("ordinals") && a.addressType === "p2tr") ??
    addresses.find((a) => a.addressType === "p2tr");
  if (!identity) throw new BridgeError("PROVIDER_ERROR", "Xverse didn't return a Taproot address.");
  const chainVerified = await assertNetwork(network, addresses.map((a) => a.address));
  return {
    provider: "xverse",
    address: identity.address,
    publicKeyHex: identity.publicKeyHex,
    addresses,
    chainVerified,
  };
}

export async function xverseSign(req: Exclude<BridgeRequest, { method: "connect" }>): Promise<unknown> {
  await ensureInstalled();
  const { address } = req.args;
  await assertNetwork(req.args.network, [address]);
  const network = { type: networkType(req.args.network) };
  // Xverse refuses to sign for an address outside its current account,
  // so passing the exact address is the account check for this provider.

  if (req.method === "signMessage") {
    const signature = await promisify<string>(xverseSignMessage, {
      address,
      message: req.args.message,
      protocol: MessageSigningProtocols.BIP322,
      network,
    });
    return { signature, schemeHint: "bip322" };
  }

  // broadcast: false — the extension finalizes and broadcasts through its
  // own indexer. Arch PSBTs carry one Taproot input; BTC sends sign each built input.
  const signingIndexes = req.method === "signBtcPsbt" ? req.args.inputIndexes : [0];
  const response = await promisify<SignTransactionResponse>(xverseSignTransaction, {
    psbtBase64: req.args.psbtBase64,
    inputsToSign: [{ address, signingIndexes }],
    broadcast: false,
    message: req.method === "signBtcPsbt" ? "Sign Bitcoin transaction" : "Sign Arch transaction",
    network,
  });
  return { signedPsbtBase64: response?.psbtBase64 };
}
