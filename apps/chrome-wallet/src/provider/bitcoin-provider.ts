import { ProviderEventEmitter } from "./events";

const CHANNEL = "arch-wallet-provider";
let requestId = 0;

function genId(): string {
  return `btc-${Date.now()}-${++requestId}`;
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

export const bitcoinProvider = {
  isArchWallet: true as const,

  async connect() {
    const result = (await sendRequest("CONNECT")) as {
      address: string;
      publicKey: string;
    };
    emitter.emit("connect", result);
    return result;
  },

  async getAccounts() {
    const account = (await sendRequest("GET_ACCOUNT")) as {
      address: string;
    } | null;
    return account ? [account.address] : [];
  },

  async sendTransfer(params: { address: string; amount: number }) {
    return (await sendRequest("SEND_TRANSFER", {
      to: params.address,
      lamports: String(params.amount),
    })) as string;
  },

  async signPsbt(params: { psbt: string; signInputs: Record<string, number[]> }) {
    return (await sendRequest("SIGN_PSBT", params)) as { psbt: string };
  },

  async signMessage(params: { address: string; message: string }) {
    return (await sendRequest("SIGN_MESSAGE", params)) as { signature: string };
  },

  on(event: string, cb: (...args: unknown[]) => void) {
    emitter.on(event, cb);
  },

  removeListener(event: string, cb: (...args: unknown[]) => void) {
    emitter.off(event, cb);
  },
};
