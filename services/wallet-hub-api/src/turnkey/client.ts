import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { TurnkeyClient } from "@turnkey/http";

type CreateBitcoinWalletParams = {
  walletName: string;
  /**
   * Turnkey-supported Bitcoin address formats.
   * Example: ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH
   */
  addressFormat:
    | "ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH"
    | "ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH"
    | "ADDRESS_FORMAT_BITCOIN_SIGNET_P2WPKH"
    | "ADDRESS_FORMAT_BITCOIN_REGTEST_P2WPKH"
    | "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR"
    | "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR"
    | "ADDRESS_FORMAT_BITCOIN_SIGNET_P2TR"
    | "ADDRESS_FORMAT_BITCOIN_REGTEST_P2TR";
  /**
   * BIP32 derivation path string.
   * Example for testnet p2wpkh: m/84'/1'/0'/0/0
   */
  path: string;
};

type CreateBitcoinWalletResult = {
  walletId: string;
  addresses: string[];
  activityId: string;
};

type SignRawPayloadParams = {
  signWith: string; // wallet account address, private key address, or privateKeyId
  payload: string;
  encoding: "PAYLOAD_ENCODING_TEXT_UTF8" | "PAYLOAD_ENCODING_HEXADECIMAL";
  hashFunction: "HASH_FUNCTION_NO_OP" | "HASH_FUNCTION_SHA256";
};

type SignRawPayloadResult = {
  r: string;
  s: string;
  v: string;
  activityId: string;
};

type SignBitcoinTransactionParams = {
  signWith: string;
  /**
   * Unsigned Bitcoin transaction representation expected by Turnkey.
   * In practice this is commonly a PSBT (base64) for segwit/taproot signing.
   */
  unsignedTransaction: string;
};

type SignBitcoinTransactionResult = {
  signedTransaction: string;
  activityId: string;
};

export type GetWalletAccountsParams = {
  walletId: string;
};

export type WalletAccount = {
  walletAccountId: string;
  walletId: string;
  address: string;
  publicKey?: string;
};

function nowMs() {
  return Date.now().toString();
}

function looksLikeBase64(s: string) {
  return /^[A-Za-z0-9+/=]+$/.test(s) && s.length % 4 === 0;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class TurnkeyService {
  private client: TurnkeyClient;
  private organizationId: string;

  constructor(params: {
    baseUrl: string;
    organizationId: string;
    apiPublicKey: string;
    apiPrivateKey: string;
  }) {
    const stamper = new ApiKeyStamper({
      apiPublicKey: params.apiPublicKey,
      apiPrivateKey: params.apiPrivateKey
    });

    this.client = new TurnkeyClient({ baseUrl: params.baseUrl }, stamper);
    this.organizationId = params.organizationId;
  }

  async ping() {
    return await this.client.getWhoami({ organizationId: this.organizationId });
  }

  private async pollActivity(activityId: string) {
    // Keep polling conservative for Phase 0; callers should expect < a few seconds.
    const maxAttempts = 60;
    const delayMs = 500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await this.client.getActivity({
        organizationId: this.organizationId,
        activityId
      });

      const activity = res.activity;
      if (
        activity.status === "ACTIVITY_STATUS_COMPLETED" ||
        activity.status === "ACTIVITY_STATUS_FAILED" ||
        activity.status === "ACTIVITY_STATUS_REJECTED" ||
        activity.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED"
      ) {
        return activity;
      }

      await sleep(delayMs);
    }

    throw new Error(`Turnkey activity polling timed out: ${activityId}`);
  }

  async createBitcoinWallet(
    params: CreateBitcoinWalletParams
  ): Promise<CreateBitcoinWalletResult> {
    const res = await this.client.createWallet({
      type: "ACTIVITY_TYPE_CREATE_WALLET",
      timestampMs: nowMs(),
      organizationId: this.organizationId,
      parameters: {
        walletName: params.walletName,
        mnemonicLength: 12,
        accounts: [
          {
            curve: "CURVE_SECP256K1",
            pathFormat: "PATH_FORMAT_BIP32",
            path: params.path,
            addressFormat: params.addressFormat
          }
        ]
      }
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId);

    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(`Turnkey createWallet did not complete: ${activityId}`);
    }

    const walletId = activity.result.createWalletResult?.walletId;
    const addresses = activity.result.createWalletResult?.addresses ?? [];
    if (!walletId) {
      throw new Error("Turnkey createWallet did not return walletId");
    }

    return { walletId, addresses, activityId };
  }

  async signRawPayload(
    params: SignRawPayloadParams
  ): Promise<SignRawPayloadResult> {
    const res = await this.client.signRawPayload({
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      timestampMs: nowMs(),
      organizationId: this.organizationId,
      parameters: {
        signWith: params.signWith,
        payload: params.payload,
        encoding: params.encoding,
        hashFunction: params.hashFunction
      }
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId);

    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(`Turnky signRawPayload did not complete: ${activityId}`);
    }

    const sig = activity.result.signRawPayloadResult;
    if (!sig) {
      throw new Error("Turnkey signRawPayload did not return a signature");
    }

    return { ...sig, activityId };
  }

  async signBitcoinTransaction(
    params: SignBitcoinTransactionParams
  ): Promise<SignBitcoinTransactionResult> {
    // Turnkey expects `unsignedTransaction` as hex for Bitcoin tx signing.
    // For our flows we commonly pass PSBT base64; normalize it to hex and then
    // re-encode the signed artifact back to base64 so downstream code can parse it.
    const inputWasBase64 = looksLikeBase64(params.unsignedTransaction);
    const unsignedHex = inputWasBase64
      ? Buffer.from(params.unsignedTransaction, "base64").toString("hex")
      : params.unsignedTransaction;

    const res = await this.client.signTransaction({
      type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
      timestampMs: nowMs(),
      organizationId: this.organizationId,
      parameters: {
        signWith: params.signWith,
        unsignedTransaction: unsignedHex,
        type: "TRANSACTION_TYPE_BITCOIN"
      }
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId);

    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(`Turnkey signTransaction did not complete: ${activityId}`);
    }

    const signedTransaction = activity.result.signTransactionResult?.signedTransaction;
    if (!signedTransaction) {
      throw new Error("Turnkey signTransaction did not return signedTransaction");
    }

    const out = inputWasBase64
      ? Buffer.from(signedTransaction, "hex").toString("base64")
      : signedTransaction;

    return { signedTransaction: out, activityId };
  }

  async getWalletAccounts(params: GetWalletAccountsParams): Promise<{ accounts: WalletAccount[] }> {
    const res = await this.client.getWalletAccounts({
      organizationId: this.organizationId,
      walletId: params.walletId,
      includeWalletDetails: false
    } as any);

    return { accounts: (res as any).accounts ?? [] };
  }
}
