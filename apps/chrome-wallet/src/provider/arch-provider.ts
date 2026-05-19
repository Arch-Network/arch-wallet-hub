import { ProviderEventEmitter } from "./events";
import { RpcChannel } from "./rpc-channel";

const channel = new RpcChannel({ prefix: "arch" });
const emitter = new ProviderEventEmitter();

export const archProvider = {
  isArchWallet: true as const,

  async connect() {
    const result = await channel.request<{ address: string; publicKey: string; archAddress: string }>("CONNECT");
    emitter.emit("connect", result);
    return result;
  },

  async disconnect() {
    await channel.request("DISCONNECT");
    emitter.emit("disconnect");
  },

  async getAccount() {
    return channel.request<{ address: string; publicKey: string; archAddress: string } | null>("GET_ACCOUNT");
  },

  async getBalance() {
    return channel.request<{ lamports: string; arch: string }>("GET_BALANCE");
  },

  async sendTransfer(params: { to: string; lamports: string }) {
    return channel.request<{ txid: string }>("SEND_TRANSFER", params);
  },

  async sendTokenTransfer(params: { mint: string; to: string; amount: string }) {
    return channel.request<{ txid: string }>("SEND_TOKEN_TRANSFER", params);
  },

  async signMessage(message: Uint8Array) {
    const hex = Array.from(message)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return channel.request<{ signature: string }>("SIGN_MESSAGE", { message: hex });
  },

  on(event: string, cb: (...args: unknown[]) => void) {
    emitter.on(event, cb);
  },

  removeListener(event: string, cb: (...args: unknown[]) => void) {
    emitter.off(event, cb);
  },
};
