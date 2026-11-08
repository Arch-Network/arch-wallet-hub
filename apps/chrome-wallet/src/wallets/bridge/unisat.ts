/**
 * UniSat, via `window.unisat` (docs.unisat.io/dev/unisat-developer-center/unisat-wallet).
 * UniSat exposes one current address, so it serves both payment and
 * ordinals. The chain and the current account are checked before every
 * signature because the user can change either in UniSat at any time.
 */
import { addressTypeOf } from "../../state/account-addresses";
import { BridgeError, bridgeErrors, networkName } from "./errors";
import { waitForProvider } from "./detect";
import type { BridgeConnectResult, BridgeNetwork, BridgeRequest } from "./protocol";

export interface UnisatProvider {
  requestAccounts(): Promise<string[]>;
  getAccounts?(): Promise<string[]>;
  getPublicKey(): Promise<string>;
  /** UniSat > 1.4.0. */
  getChain?(): Promise<{ enum: string; name?: string }>;
  /** Deprecated: "livenet" | "testnet", which can't tell Testnet4 from Testnet3 or Signet. */
  getNetwork?(): Promise<string>;
  signMessage?(message: string, type?: "ecdsa" | "bip322-simple"): Promise<string>;
  signPsbt?(
    psbtHex: string,
    options?: { autoFinalized?: boolean; toSignInputs?: Array<{ index: number; address: string }> },
  ): Promise<string>;
}

declare global {
  interface Window {
    unisat?: UnisatProvider;
  }
}

const LABEL = "UniSat";
const CHAIN_ENUM: Record<BridgeNetwork, string> = {
  mainnet: "BITCOIN_MAINNET",
  testnet4: "BITCOIN_TESTNET4",
};

async function provider(): Promise<UnisatProvider> {
  const p = await waitForProvider(() => window.unisat);
  if (!p) throw bridgeErrors.missing(LABEL);
  return p;
}

export async function assertUnisatChain(p: UnisatProvider, network: BridgeNetwork): Promise<void> {
  if (typeof p.getChain === "function") {
    const chain = await p.getChain();
    if (chain?.enum !== CHAIN_ENUM[network]) {
      throw bridgeErrors.wrongNetwork(LABEL, network, chain?.name || chain?.enum || "another network");
    }
    return;
  }
  if (network === "mainnet") {
    const legacy = await p.getNetwork?.();
    if (legacy === "livenet") return;
    throw bridgeErrors.wrongNetwork(LABEL, network, "a test network");
  }
  throw bridgeErrors.unsupported(
    `This version of UniSat can't confirm it's on ${networkName(network)}. Update UniSat, then try again.`,
  );
}

export async function assertUnisatAccount(p: UnisatProvider, address: string): Promise<void> {
  let accounts = (await p.getAccounts?.()) ?? [];
  // Empty means locked or not connected to this page; requestAccounts lets UniSat prompt.
  if (accounts.length === 0) accounts = await p.requestAccounts();
  if (accounts[0] !== address) throw bridgeErrors.accountMismatch(LABEL, address);
}

function base64ToHex(base64: string): string {
  return Array.from(atob(base64), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

export async function unisatConnect(network: BridgeNetwork): Promise<BridgeConnectResult> {
  const p = await provider();
  await assertUnisatChain(p, network);
  const [address] = await p.requestAccounts();
  if (!address) throw new BridgeError("PROVIDER_ERROR", "UniSat didn't return an account.");
  if (addressTypeOf(address) !== "p2tr") throw bridgeErrors.notTaproot(LABEL);
  const publicKeyHex = (await p.getPublicKey()) || "";
  return {
    provider: "unisat",
    address,
    publicKeyHex,
    addresses: [{ address, publicKeyHex, purposes: ["payment", "ordinals"], addressType: "p2tr" }],
    chainVerified: true,
  };
}

export async function unisatSign(req: Exclude<BridgeRequest, { method: "connect" }>): Promise<unknown> {
  const p = await provider();
  await assertUnisatChain(p, req.args.network);
  await assertUnisatAccount(p, req.args.address);

  if (req.method === "signMessage") {
    if (!p.signMessage) throw bridgeErrors.unsupported("This version of UniSat can't sign messages.");
    return { signature: await p.signMessage(req.args.message, "bip322-simple"), schemeHint: "bip322" };
  }
  if (!p.signPsbt) throw bridgeErrors.unsupported("This version of UniSat can't sign transactions.");
  const psbtHex = base64ToHex(req.args.psbtBase64);
  // autoFinalized stays false: the extension finalizes and broadcasts through its own indexer.
  if (req.method === "signPsbt") {
    return { signedPsbtHex: await p.signPsbt(psbtHex, { autoFinalized: false }) };
  }
  const { address, inputIndexes } = req.args;
  return {
    signedPsbtHex: await p.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs: inputIndexes.map((index) => ({ index, address })),
    }),
  };
}
