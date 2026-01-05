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

function nowMs() {
  return Date.now().toString();
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
}

