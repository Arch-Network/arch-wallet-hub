import type { WalletHubClient } from "@arch/wallet-hub-sdk";
import type { WalletAccount } from "../store/types";
import { deriveArchAccountAddress } from "../utils/crypto";
import { Platform } from "react-native";

function toBase64(str: string): string {
  if (typeof btoa === "function") return btoa(str);
  return str;
}

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateUUID(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // Fallback: 128-bit hex (16 bytes). Never use Math.random for any
  // crypto-adjacent identifier.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * SECURITY: passkeys must be bound to a stable, publisher-controlled
 * Relying Party id; binding them to `localhost` (or the WebView's
 * current page hostname) means any localhost-serving app or the
 * current page can later assert the credential. We pin to
 * `wallet.arch.network` in production and only allow `localhost`
 * in `__DEV__` builds.
 */
function getRpId(): string {
  const PROD_RP_ID = "wallet.arch.network";
  if (__DEV__) {
    if (Platform.OS === "web") {
      const hostname = globalThis.location?.hostname;
      return hostname || "localhost";
    }
    return "localhost";
  }
  return PROD_RP_ID;
}

export interface WalletCreationCallbacks {
  onStatus?: (message: string) => void;
}

interface PasskeyResult {
  challenge: string;
  attestation: {
    credentialId: string;
    clientDataJson: string;
    attestationObject: string;
    transports?: string[];
  };
}

/**
 * On native, delegates to @turnkey/react-native-passkey-stamper.
 * On web, uses the browser WebAuthn API directly.
 */
async function createPlatformPasskey(
  rpId: string,
  rpName: string,
  userId: string,
  userName: string,
  displayName: string,
  authenticatorName: string
): Promise<PasskeyResult> {
  if (Platform.OS !== "web") {
    const { createPasskey } = await import("@turnkey/react-native-passkey-stamper");
    const result = await createPasskey({
      authenticatorName,
      rp: { id: rpId, name: rpName },
      user: { id: toBase64(userId), name: userName, displayName },
    });
    return {
      challenge: result.challenge,
      attestation: result.attestation as PasskeyResult["attestation"],
    };
  }

  // Web: use native WebAuthn API
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const encodedChallenge = toBase64Url(challenge.buffer as ArrayBuffer);

  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: rpName },
      user: {
        id: new TextEncoder().encode(userId),
        name: userName,
        displayName,
      },
      challenge,
      pubKeyCredParams: [
        { alg: -7, type: "public-key" },
        { alg: -257, type: "public-key" },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "preferred",
        userVerification: "required",
      },
      attestation: "direct",
    },
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Passkey creation was cancelled");
  }

  const response = credential.response as AuthenticatorAttestationResponse;
  const rawTransports =
    typeof response.getTransports === "function"
      ? response.getTransports()
      : ["internal"];

  const transportMap: Record<string, string> = {
    ble: "AUTHENTICATOR_TRANSPORT_BLE",
    internal: "AUTHENTICATOR_TRANSPORT_INTERNAL",
    nfc: "AUTHENTICATOR_TRANSPORT_NFC",
    usb: "AUTHENTICATOR_TRANSPORT_USB",
    hybrid: "AUTHENTICATOR_TRANSPORT_HYBRID",
  };
  const transports = rawTransports
    .map((t) => transportMap[t])
    .filter(Boolean);

  return {
    challenge: encodedChallenge,
    attestation: {
      credentialId: toBase64Url(credential.rawId),
      clientDataJson: toBase64Url(response.clientDataJSON),
      attestationObject: toBase64Url(response.attestationObject),
      transports: transports.length > 0 ? transports : ["AUTHENTICATOR_TRANSPORT_INTERNAL"],
    },
  };
}

/**
 * Creates a non-custodial passkey wallet using Turnkey.
 *
 * Flow:
 * 1. Fetch Turnkey config from backend
 * 2. Create a passkey on the device (biometric/WebAuthn prompt)
 * 3. Send passkey attestation to backend to create sub-org + wallet
 * 4. Return a fully-populated WalletAccount
 */
export async function createPasskeyWallet(
  client: WalletHubClient,
  externalUserId: string,
  walletName: string,
  callbacks?: WalletCreationCallbacks
): Promise<WalletAccount> {
  const { onStatus } = callbacks ?? {};

  onStatus?.("Fetching server configuration...");
  const config = await client.getTurnkeyConfig();

  const rpId = getRpId();
  const displayName = walletName.trim() || "Arch Wallet";
  const userName = `${externalUserId}-${Date.now()}`;

  onStatus?.("Creating passkey \u2014 follow the prompt...");

  const passkey = await createPlatformPasskey(
    rpId,
    "Arch Wallet",
    `${externalUserId}-${Date.now()}`,
    userName,
    displayName,
    `${displayName} Passkey`
  );

  onStatus?.("Creating your wallet on the server...");

  const idempotencyKey = generateUUID();

  const result = await client.createTurnkeyPasskeyWallet({
    idempotencyKey,
    body: {
      externalUserId,
      passkey: {
        challenge: passkey.challenge,
        attestation: passkey.attestation,
      },
    },
  });

  return {
    id: result.resourceId,
    label: walletName.trim() || "Passkey Wallet",
    btcAddress: result.defaultAddress || "",
    publicKeyHex: result.defaultPublicKeyHex || "",
    archAddress: result.defaultPublicKeyHex
      ? deriveArchAccountAddress(result.defaultPublicKeyHex)
      : undefined,
    turnkeyResourceId: result.resourceId,
    organizationId: result.organizationId,
    isCustodial: false,
    createdAt: Date.now(),
  };
}

/**
 * Creates a custodial (server-side) wallet — no passkey required.
 * Useful for simulator testing where passkeys aren't available.
 */
export async function createCustodialWallet(
  client: WalletHubClient,
  externalUserId: string,
  walletName: string,
  callbacks?: WalletCreationCallbacks
): Promise<WalletAccount> {
  const { onStatus } = callbacks ?? {};

  onStatus?.("Creating custodial wallet...");

  const idempotencyKey = generateUUID();

  const result = await client.createTurnkeyWallet({
    idempotencyKey,
    body: { externalUserId, walletName: walletName.trim() || "Custodial Wallet" },
  });

  return {
    id: result.resourceId,
    label: walletName.trim() || "Custodial Wallet",
    btcAddress: result.defaultAddress || "",
    publicKeyHex: result.defaultPublicKeyHex || "",
    archAddress: result.defaultPublicKeyHex
      ? deriveArchAccountAddress(result.defaultPublicKeyHex)
      : undefined,
    turnkeyResourceId: result.resourceId,
    organizationId: result.organizationId,
    isCustodial: true,
    createdAt: Date.now(),
  };
}

/**
 * Imports an existing wallet by looking up previously created wallets for this user.
 */
export async function importExistingWallet(
  client: WalletHubClient,
  externalUserId: string,
  callbacks?: WalletCreationCallbacks
): Promise<WalletAccount> {
  const { onStatus } = callbacks ?? {};

  onStatus?.("Looking for existing wallets...");

  const res = await client.listTurnkeyWallets(externalUserId);
  const wallets = res?.wallets ?? [];

  if (wallets.length === 0) {
    throw new Error("No existing wallets found. Create a new wallet first.");
  }

  const tw = wallets[0] as Record<string, unknown>;
  const isCustodial = !tw.subOrganizationId;
  const pubHex = String(tw.defaultPublicKeyHex || "");

  return {
    id: String(tw.resourceId || tw.id),
    label: isCustodial ? "Imported Custodial" : "Imported Passkey",
    btcAddress: String(tw.defaultAddress || ""),
    publicKeyHex: pubHex,
    archAddress: pubHex ? deriveArchAccountAddress(pubHex) : undefined,
    turnkeyResourceId: String(tw.resourceId || tw.id),
    organizationId: String(tw.organizationId || ""),
    isCustodial,
    createdAt: Date.now(),
  };
}
