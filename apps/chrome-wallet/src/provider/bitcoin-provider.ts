import { ProviderEventEmitter } from "./events";
import { RpcChannel } from "./rpc-channel";

const channel = new RpcChannel({ prefix: "btc" });
const emitter = new ProviderEventEmitter();

/**
 * `window.bitcoinArch`: the Bitcoin-facing surface of Arch Wallet. It
 * exposes only what the wallet implements with Bitcoin semantics:
 * connect, accounts, and PSBT signing behind the approval popup.
 *
 * There is no `sendTransfer` or `signMessage`. The former routed to an
 * Arch lamport transfer and the latter to Arch message signing, which a
 * Bitcoin dapp would misread; absent methods make feature detection
 * honest. ARCH transfers and Arch message signing live on `window.arch`.
 */
export const bitcoinProvider = {
  isArchWallet: true as const,
  /** Identifies this provider for wallet-standard adapters. */
  name: "Arch Wallet" as const,

  async connect() {
    const result = await channel.request<{ address: string; publicKey: string }>("CONNECT");
    emitter.emit("connect", result);
    return result;
  },

  async getAccounts() {
    const account = await channel.request<{ address: string } | null>("GET_ACCOUNT");
    return account ? [account.address] : [];
  },

  /** `psbt` may be hex or base64; the signed PSBT comes back in the same encoding. */
  async signPsbt(params: { psbt: string; signInputs?: Record<string, number[]> }) {
    return channel.request<{ psbt: string }>("SIGN_PSBT", params);
  },

  on(event: string, cb: (...args: unknown[]) => void) {
    emitter.on(event, cb);
  },

  removeListener(event: string, cb: (...args: unknown[]) => void) {
    emitter.off(event, cb);
  },
};
