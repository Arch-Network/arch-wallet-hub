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

  /**
   * Sign an Arch SanitizedMessage hash (the 32-byte digest produced
   * by `SanitizedMessageUtil.hash(message)` in `@saturnbtcio/arch-sdk`)
   * and return the 64-byte (r||s) Schnorr signature as hex.
   *
   * The signer wraps the hash in the BIP-322 to-sign taproot sighash
   * for the connected account's BTC address and signs that digest
   * locally via the in-extension Turnkey session -- no Wallet Hub
   * round-trip. The returned signature is what arch-sdk's
   * `SignatureUtil.adjustSignature` accepts directly (length === 64
   * branch), so dapps can build their own `RuntimeTransaction` and
   * submit via any Arch RPC.
   *
   * Designed for dapps with custom Arch programs whose instructions
   * are not covered by Wallet Hub's canonical `arch.*` action types.
   * Always gated by the same approval popup as the other signing
   * methods.
   */
  async signArchMessageHash(messageHash: Uint8Array) {
    if (messageHash.length !== 32) {
      throw new Error(
        `signArchMessageHash expects a 32-byte hash; got ${messageHash.length} bytes`,
      );
    }
    const messageHashHex = Array.from(messageHash)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return channel.request<{ signature64Hex: string }>(
      "SIGN_ARCH_MESSAGE_HASH",
      { messageHashHex },
    );
  },

  on(event: string, cb: (...args: unknown[]) => void) {
    emitter.on(event, cb);
  },

  removeListener(event: string, cb: (...args: unknown[]) => void) {
    emitter.off(event, cb);
  },
};
