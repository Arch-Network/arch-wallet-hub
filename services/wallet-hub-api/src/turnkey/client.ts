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

type CreateSubOrganizationWithWalletParams = {
  subOrganizationName: string;
  rootUser: {
    userName: string;
    userEmail?: string;
    passkey: {
      challenge: string; // base64url
      attestation: unknown;
    };
  };
  wallet: {
    walletName: string;
    addressFormat: CreateBitcoinWalletParams["addressFormat"];
    path: string;
  };
};

type CreateSubOrganizationWithWalletResult = {
  subOrganizationId: string;
  rootUserId: string | null;
  walletId: string;
  addresses: string[];
  activityId: string;
};

/**
 * Email-only sub-org creation. Mirrors the passkey-flavor params
 * but the root user has neither authenticators nor pre-attached
 * API keys. Auth bootstraps later via OTP_AUTH:
 *   1. Client calls `/recovery/email/init` -- Hub initiates OTP.
 *   2. User receives code, returns it to the client.
 *   3. Client calls `/recovery/email/verify` with an ephemeral
 *      P-256 pubkey it generated locally.
 *   4. Hub forwards to OTP_AUTH; Turnkey HPKE-encrypts a 15-minute
 *      recovery API key to the ephemeral pubkey.
 *   5. Client decrypts, stamps CREATE_API_KEYS_V2 to register its
 *      IndexedDB session key as the user's permanent credential.
 *
 * The Hub never sees a long-lived API key for the user.
 */
type CreateSubOrganizationWithEmailWalletParams = {
  subOrganizationName: string;
  rootUser: {
    userName: string;
    userEmail: string;
  };
  wallet: {
    walletName: string;
    addressFormat: CreateBitcoinWalletParams["addressFormat"];
    path: string;
  };
};

type CreateSubOrganizationWithEmailWalletResult =
  CreateSubOrganizationWithWalletResult;

type CreateApiKeyForUserParams = {
  organizationId: string;
  userId: string;
  apiKeyName: string;
  publicKey: string; // compressed P-256 public key hex
  curveType: "API_KEY_CURVE_P256";
  expirationSeconds?: string;
};

type SignRawPayloadParams = {
  signWith: string; // wallet account address, private key address, or privateKeyId
  payload: string;
  encoding: "PAYLOAD_ENCODING_TEXT_UTF8" | "PAYLOAD_ENCODING_HEXADECIMAL";
  hashFunction: "HASH_FUNCTION_NO_OP" | "HASH_FUNCTION_SHA256";
  organizationId?: string; // Optional: override for sub-organization signing
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

  private async pollActivity(activityId: string, organizationId?: string) {
    // Keep polling conservative for Phase 0; callers should expect < a few seconds.
    const maxAttempts = 60;
    const delayMs = 500;
    const orgId = organizationId ?? this.organizationId;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await this.client.getActivity({
        organizationId: orgId,
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

  /**
   * Create a sub-organization with a root passkey user and an initial wallet.
   * This aligns with Turnkey's "sub-org as wallet" embedded wallet model.
   */
  async createSubOrganizationWithWallet(
    params: CreateSubOrganizationWithWalletParams
  ): Promise<CreateSubOrganizationWithWalletResult> {
    const res = await (this.client as any).createSubOrganization({
      type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4",
      timestampMs: nowMs(),
      organizationId: this.organizationId,
      parameters: {
        subOrganizationName: params.subOrganizationName,
        rootUsers: [
          {
            userName: params.rootUser.userName,
            userEmail: params.rootUser.userEmail,
            apiKeys: [],
            authenticators: [
              {
                authenticatorName: "Passkey",
                challenge: params.rootUser.passkey.challenge,
                attestation: params.rootUser.passkey.attestation
              }
            ]
          }
        ],
        rootQuorumThreshold: 1,
        wallet: {
          walletName: params.wallet.walletName,
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              pathFormat: "PATH_FORMAT_BIP32",
              path: params.wallet.path,
              addressFormat: params.wallet.addressFormat
            }
          ]
        }
      }
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId);
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(`Turnkey createSubOrganization did not complete: ${activityId}`);
    }

    const result =
      (activity.result as any).createSubOrganizationResultV4 ??
      (activity.result as any).createSubOrganizationResultV5 ??
      (activity.result as any).createSubOrganizationResultV6 ??
      (activity.result as any).createSubOrganizationResultV7 ??
      null;

    if (!result?.subOrganizationId) {
      throw new Error("Turnkey createSubOrganization did not return subOrganizationId");
    }
    const walletId = result.wallet?.walletId;
    const addresses = result.wallet?.addresses ?? [];
    if (!walletId) throw new Error("Turnkey createSubOrganization did not return walletId");

    const rootUserId = Array.isArray(result.rootUserIds) ? (result.rootUserIds[0] ?? null) : null;

    return {
      subOrganizationId: result.subOrganizationId,
      rootUserId,
      walletId,
      addresses,
      activityId
    };
  }

  /**
   * Create a sub-organization with a root *email-only* user and an
   * initial wallet. The root user has no authenticators and no
   * API keys; the only way to act as them is via Turnkey's
   * `OTP_AUTH` flow (Hub-initiated, email-delivered code,
   * client-decrypted credential bundle).
   *
   * This intentionally mirrors `createSubOrganizationWithWallet`
   * minus the `authenticators` field on the root user. We keep the
   * same `CREATE_SUB_ORGANIZATION_V4` activity type so we don't
   * have to maintain two slightly-different code paths for the
   * activity polling logic.
   */
  async createSubOrganizationWithEmailWallet(
    params: CreateSubOrganizationWithEmailWalletParams,
  ): Promise<CreateSubOrganizationWithEmailWalletResult> {
    const res = await (this.client as any).createSubOrganization({
      type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V4",
      timestampMs: nowMs(),
      organizationId: this.organizationId,
      parameters: {
        subOrganizationName: params.subOrganizationName,
        rootUsers: [
          {
            userName: params.rootUser.userName,
            userEmail: params.rootUser.userEmail,
            apiKeys: [],
            authenticators: [],
          },
        ],
        rootQuorumThreshold: 1,
        wallet: {
          walletName: params.wallet.walletName,
          accounts: [
            {
              curve: "CURVE_SECP256K1",
              pathFormat: "PATH_FORMAT_BIP32",
              path: params.wallet.path,
              addressFormat: params.wallet.addressFormat,
            },
          ],
        },
      },
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId);
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(
        `Turnkey createSubOrganization (email) did not complete: ${activityId}`,
      );
    }

    const result =
      (activity.result as any).createSubOrganizationResultV4 ??
      (activity.result as any).createSubOrganizationResultV5 ??
      (activity.result as any).createSubOrganizationResultV6 ??
      (activity.result as any).createSubOrganizationResultV7 ??
      null;
    if (!result?.subOrganizationId) {
      throw new Error(
        "Turnkey createSubOrganization (email) did not return subOrganizationId",
      );
    }
    const walletId = result.wallet?.walletId;
    const addresses = result.wallet?.addresses ?? [];
    if (!walletId) {
      throw new Error(
        "Turnkey createSubOrganization (email) did not return walletId",
      );
    }
    const rootUserId = Array.isArray(result.rootUserIds)
      ? result.rootUserIds[0] ?? null
      : null;

    return {
      subOrganizationId: result.subOrganizationId,
      rootUserId,
      walletId,
      addresses,
      activityId,
    };
  }

  async createApiKeyForUser(params: CreateApiKeyForUserParams): Promise<{ apiKeyIds: string[]; activityId: string }> {
    const res = await (this.client as any).createApiKeys({
      type: "ACTIVITY_TYPE_CREATE_API_KEYS_V2",
      timestampMs: nowMs(),
      organizationId: params.organizationId,
      parameters: {
        userId: params.userId,
        apiKeys: [
          {
            apiKeyName: params.apiKeyName,
            publicKey: params.publicKey,
            curveType: params.curveType,
            ...(params.expirationSeconds ? { expirationSeconds: params.expirationSeconds } : {})
          }
        ]
      }
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId);
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(`Turnkey createApiKeys did not complete: ${activityId}`);
    }
    const apiKeyIds = (activity.result as any)?.createApiKeysResult?.apiKeyIds ?? [];
    return { apiKeyIds, activityId };
  }

  /**
   * Phase 1.10 -- begin an email-OTP recovery for the given user.
   * Turnkey hosts the email infrastructure and templates; we just
   * point them at the right (orgId, userId, email) and they send the
   * code. Returns an `otpId` the caller persists against its
   * `recovery_challenges` row so the matching OTP_AUTH later can
   * resolve back to the right activity.
   *
   * `contact` is the email address the OTP is sent to. Turnkey
   * cross-checks this against the user's stored `userEmail` and
   * rejects if they don't match -- we forward `body.userEmail` at
   * sign-up specifically so this check passes during recovery.
   */
  async initOtpAuth(params: {
    organizationId: string;
    userId: string;
    contact: string;
    emailCustomization?: Record<string, unknown>;
  }): Promise<{ otpId: string; activityId: string }> {
    const res = await (this.client as any).initOtpAuth({
      type: "ACTIVITY_TYPE_INIT_OTP_AUTH",
      timestampMs: nowMs(),
      organizationId: params.organizationId,
      parameters: {
        otpType: "OTP_TYPE_EMAIL",
        contact: params.contact,
        userId: params.userId,
        ...(params.emailCustomization
          ? { emailCustomization: params.emailCustomization }
          : {})
      }
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId, params.organizationId);
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(`Turnkey initOtpAuth did not complete: ${activityId}`);
    }
    const otpId = (activity.result as any)?.initOtpAuthResult?.otpId;
    if (!otpId) throw new Error("Turnkey initOtpAuth did not return otpId");
    return { otpId, activityId };
  }

  /**
   * Phase 1.10 -- exchange an OTP code (from the user's email inbox)
   * for an HPKE-encrypted credential bundle that grants the client a
   * short-lived API key. The browser HPKE-decrypts the bundle using
   * the private half of `targetPublicKey` and then uses the recovered
   * key to stamp `CREATE_AUTHENTICATORS` against the sub-org,
   * attaching a fresh passkey.
   *
   * `targetPublicKey` is the *raw* P-256 public key the client wants
   * the recovery key issued under (65-byte hex, 0x04-prefixed
   * uncompressed). Generate this client-side, never expose the
   * private half.
   *
   * If the OTP is wrong or expired Turnkey returns an
   * `ACTIVITY_STATUS_FAILED` activity which we surface as a generic
   * error -- the caller is responsible for incrementing `attempts`
   * on the recovery_challenges row.
   */
  async otpAuth(params: {
    organizationId: string;
    otpId: string;
    otpCode: string;
    targetPublicKey: string;
    apiKeyName: string;
    expirationSeconds: string;
  }): Promise<{ credentialBundle: string; apiKeyId: string; activityId: string }> {
    const res = await (this.client as any).otpAuth({
      type: "ACTIVITY_TYPE_OTP_AUTH",
      timestampMs: nowMs(),
      organizationId: params.organizationId,
      parameters: {
        otpId: params.otpId,
        otpCode: params.otpCode,
        targetPublicKey: params.targetPublicKey,
        apiKeyName: params.apiKeyName,
        expirationSeconds: params.expirationSeconds
      }
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId, params.organizationId);
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new Error(`Turnkey otpAuth did not complete: ${activityId}`);
    }
    const result = (activity.result as any)?.otpAuthResult;
    const credentialBundle = result?.credentialBundle;
    const apiKeyId = result?.apiKeyId;
    if (!credentialBundle || !apiKeyId) {
      throw new Error("Turnkey otpAuth did not return credentialBundle/apiKeyId");
    }
    return { credentialBundle, apiKeyId, activityId };
  }

  async signRawPayload(
    params: SignRawPayloadParams
  ): Promise<SignRawPayloadResult> {
    const targetOrgId = params.organizationId ?? this.organizationId;
    const res = await this.client.signRawPayload({
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      timestampMs: nowMs(),
      organizationId: targetOrgId,
      parameters: {
        signWith: params.signWith,
        payload: params.payload,
        encoding: params.encoding,
        hashFunction: params.hashFunction
      }
    });

    const activityId = res.activity.id;
    const activity = await this.pollActivity(activityId, targetOrgId);

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

  async getWalletAccountsForOrganization(params: {
    organizationId: string;
    walletId: string;
  }): Promise<{ accounts: WalletAccount[] }> {
    const res = await this.client.getWalletAccounts({
      organizationId: params.organizationId,
      walletId: params.walletId,
      includeWalletDetails: false
    } as any);
    return { accounts: (res as any).accounts ?? [] };
  }
}
