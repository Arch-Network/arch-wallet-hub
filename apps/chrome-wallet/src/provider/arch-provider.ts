import { ProviderEventEmitter } from "./events";

const CHANNEL = "arch-wallet-provider";
let requestId = 0;

function genId(): string {
  return `arch-${Date.now()}-${++requestId}`;
}

function sendRequest(type: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = genId();

    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (event.data?.channel !== CHANNEL) return;
      if (event.data?.direction !== "to-page") return;
      if (event.data?.id !== id) return;

      window.removeEventListener("message", handler);
      const response = event.data.response;
      if (response?.success) {
        resolve(response.data);
      } else {
        reject(new Error(response?.error ?? "Request failed"));
      }
    };

    window.addEventListener("message", handler);
    window.postMessage(
      { channel: CHANNEL, direction: "to-extension", payload: { type, id, payload } },
      "*"
    );

    setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("Request timed out"));
    }, 120_000);
  });
}

const emitter = new ProviderEventEmitter();

export const archProvider = {
  isArchWallet: true as const,

  async connect() {
    const result = (await sendRequest("CONNECT")) as {
      address: string;
      publicKey: string;
      archAddress: string;
    };
    emitter.emit("connect", result);
    return result;
  },

  async disconnect() {
    await sendRequest("DISCONNECT");
    emitter.emit("disconnect");
  },

  async getAccount() {
    return (await sendRequest("GET_ACCOUNT")) as {
      address: string;
      publicKey: string;
      archAddress: string;
    } | null;
  },

  async getBalance() {
    return (await sendRequest("GET_BALANCE")) as { lamports: string; arch: string };
  },

  async sendTransfer(params: { to: string; lamports: string }) {
    return (await sendRequest("SEND_TRANSFER", params)) as { txid: string };
  },

  async sendTokenTransfer(params: { mint: string; to: string; amount: string }) {
    return (await sendRequest("SEND_TOKEN_TRANSFER", params)) as { txid: string };
  },

  async signMessage(message: Uint8Array) {
    const hex = Array.from(message)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return (await sendRequest("SIGN_MESSAGE", { message: hex })) as { signature: string };
  },

  on(event: string, cb: (...args: unknown[]) => void) {
    emitter.on(event, cb);
  },

  removeListener(event: string, cb: (...args: unknown[]) => void) {
    emitter.off(event, cb);
  },
};
