import { ProviderEventEmitter } from "./events";
import { RpcChannel } from "./rpc-channel";

const channel = new RpcChannel({ prefix: "btc" });
const emitter = new ProviderEventEmitter();

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

  async sendTransfer(params: { address: string; amount: number }) {
    return channel.request<string>("SEND_TRANSFER", {
      to: params.address,
      lamports: String(params.amount),
    });
  },

  async signPsbt(params: { psbt: string; signInputs?: Record<string, number[]> }) {
    return channel.request<{ psbt: string }>("SIGN_PSBT", params);
  },

  async signMessage(params: { address: string; message: string }) {
    return channel.request<{ signature: string }>("SIGN_MESSAGE", params);
  },

  on(event: string, cb: (...args: unknown[]) => void) {
    emitter.on(event, cb);
  },

  removeListener(event: string, cb: (...args: unknown[]) => void) {
    emitter.off(event, cb);
  },
};
