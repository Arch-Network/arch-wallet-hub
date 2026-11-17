/**
 * Seed and private-key export, and seed import, stamped by the user's
 * Turnkey session.
 *
 * The encrypted bundle is injected into Turnkey's iframe. That page
 * decrypts and displays it. This module never reads the plaintext.
 */
import { assertActivityCompleted, type TurnkeyClient } from "@turnkey/http";
import { KeyFormat } from "@turnkey/iframe-stamper";
import type { NetworkId } from "../state/types";
import {
  bitcoinTaprootAccount,
  readImportedWallet,
  readResultString,
  walletIdForAddress,
  type TurnkeyActivity,
} from "./turnkey-material";

export const TURNKEY_EXPORT_IFRAME_URL = "https://export.turnkey.com";
export const TURNKEY_IMPORT_IFRAME_URL = "https://import.turnkey.com";

const FRAME_LOAD_TIMEOUT_MS = 20_000;

export interface ExportFrame {
  init(): Promise<string>;
  injectWalletExportBundle(bundle: string, organizationId: string): Promise<boolean>;
  injectKeyExportBundle(
    bundle: string,
    organizationId: string,
    keyFormat?: KeyFormat,
    address?: string,
  ): Promise<boolean>;
}

export interface ImportFrame {
  init(): Promise<string>;
  applySettings(settings: { styles?: Record<string, string> }): Promise<boolean>;
  injectImportBundle(bundle: string, organizationId: string, userId: string): Promise<boolean>;
  extractWalletEncryptedBundle(): Promise<string>;
}

interface ActivityResponse {
  activity: TurnkeyActivity;
}

async function initFrame(frame: { init(): Promise<string> }): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Turnkey's secure page didn't load. Try again.")),
      FRAME_LOAD_TIMEOUT_MS,
    );
  });
  try {
    const publicKey = await Promise.race([frame.init(), timeout]);
    if (!publicKey) throw new Error("Turnkey's secure page didn't load. Try again.");
    return publicKey;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settle(
  client: TurnkeyClient,
  organizationId: string,
  response: ActivityResponse,
): Promise<TurnkeyActivity> {
  let activity = response.activity;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (
      activity.status !== "ACTIVITY_STATUS_PENDING" &&
      activity.status !== "ACTIVITY_STATUS_CREATED"
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const next = await client.getActivity({
      organizationId,
      activityId: activity.id,
    });
    activity = next.activity;
  }
  assertActivityCompleted(activity as never);
  return activity;
}

export async function findWalletId(
  client: TurnkeyClient,
  organizationId: string,
  address: string,
): Promise<string> {
  const listed = await client.getWallets({ organizationId });
  const wallets = listed.wallets ?? [];
  const groups = [];
  for (const wallet of wallets) {
    const accounts = await client.getWalletAccounts({
      organizationId,
      walletId: wallet.walletId,
    });
    groups.push({
      walletId: wallet.walletId,
      accounts: accounts.accounts ?? [],
    });
  }
  const walletId = walletIdForAddress(groups, address);
  if (!walletId) {
    throw new Error("This address is not a wallet Turnkey can export.");
  }
  return walletId;
}

export async function revealSeedPhrase(
  client: TurnkeyClient,
  frame: ExportFrame,
  args: { organizationId: string; address: string },
): Promise<void> {
  const targetPublicKey = await initFrame(frame);
  const walletId = await findWalletId(client, args.organizationId, args.address);
  const response = await client.exportWallet({
    type: "ACTIVITY_TYPE_EXPORT_WALLET",
    timestampMs: Date.now().toString(),
    organizationId: args.organizationId,
    parameters: {
      walletId,
      targetPublicKey,
      language: "MNEMONIC_LANGUAGE_ENGLISH",
    },
  });
  const activity = await settle(client, args.organizationId, response);
  const bundle = readResultString(activity.result, "exportWalletResult", "exportBundle");
  await frame.injectWalletExportBundle(bundle, args.organizationId);
}

export async function revealAccountKey(
  client: TurnkeyClient,
  frame: ExportFrame,
  args: { organizationId: string; address: string; network: NetworkId },
): Promise<void> {
  const targetPublicKey = await initFrame(frame);
  const response = await client.exportWalletAccount({
    type: "ACTIVITY_TYPE_EXPORT_WALLET_ACCOUNT",
    timestampMs: Date.now().toString(),
    organizationId: args.organizationId,
    parameters: {
      address: args.address,
      targetPublicKey,
    },
  });
  const activity = await settle(client, args.organizationId, response);
  const bundle = readResultString(activity.result, "exportWalletAccountResult", "exportBundle");
  const format =
    args.network === "mainnet" ? KeyFormat.BitcoinMainNetWIF : KeyFormat.BitcoinTestNetWIF;
  await frame.injectKeyExportBundle(bundle, args.organizationId, format, args.address);
}

export async function prepareSeedImport(
  client: TurnkeyClient,
  frame: ImportFrame,
  args: { organizationId: string; styles?: Record<string, string> },
): Promise<string> {
  await initFrame(frame);
  if (args.styles) {
    await frame.applySettings({ styles: args.styles }).catch(() => false);
  }
  const who = await client.getWhoami({ organizationId: args.organizationId });
  if (!who.userId) throw new Error("Turnkey did not identify this wallet's user.");
  const response = await client.initImportWallet({
    type: "ACTIVITY_TYPE_INIT_IMPORT_WALLET",
    timestampMs: Date.now().toString(),
    organizationId: args.organizationId,
    parameters: { userId: who.userId },
  });
  const activity = await settle(client, args.organizationId, response);
  const bundle = readResultString(activity.result, "initImportWalletResult", "importBundle");
  await frame.injectImportBundle(bundle, args.organizationId, who.userId);
  return who.userId;
}

export async function finishSeedImport(
  client: TurnkeyClient,
  frame: ImportFrame,
  args: {
    organizationId: string;
    userId: string;
    walletName: string;
    network: NetworkId;
  },
): Promise<{ walletId: string; address: string; publicKeyHex: string }> {
  const encryptedBundle = await frame.extractWalletEncryptedBundle();
  const spec = bitcoinTaprootAccount(args.network);
  const response = await client.importWallet({
    type: "ACTIVITY_TYPE_IMPORT_WALLET",
    timestampMs: Date.now().toString(),
    organizationId: args.organizationId,
    parameters: {
      userId: args.userId,
      walletName: args.walletName,
      encryptedBundle,
      accounts: [
        {
          curve: "CURVE_SECP256K1",
          pathFormat: "PATH_FORMAT_BIP32",
          path: spec.path,
          addressFormat: spec.addressFormat,
        },
      ],
    },
  });
  const activity = await settle(client, args.organizationId, response);
  const imported = readImportedWallet(activity.result);
  const accounts = await client.getWalletAccounts({
    organizationId: args.organizationId,
    walletId: imported.walletId,
  });
  const match = (accounts.accounts ?? []).find((account) => account.address === imported.address);
  if (!match?.publicKey) {
    throw new Error("Turnkey did not return a public key for the imported address.");
  }
  return {
    walletId: imported.walletId,
    address: imported.address,
    publicKeyHex: match.publicKey,
  };
}
