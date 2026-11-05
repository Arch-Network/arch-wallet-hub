import type { WalletAccount } from "../state/types";
import { isExternalAccount, isWatchAccount } from "../state/types";
import { walletStore } from "../state/wallet-store";
import { getClient, getExternalUserId } from "./sdk";
import { pickHubResource } from "./hub-resource-match";

const confirmed = new Set<string>();

/**
 * Point `account` at the Hub resource row when recovery stored
 * Turnkey's wallet id instead. Persists the correction. Failures
 * leave the account unchanged so a later approve can try again.
 */
export async function reconcileHubResourceId(account: WalletAccount): Promise<void> {
  if (isWatchAccount(account) || isExternalAccount(account)) return;
  if (!account.turnkeyResourceId || !account.organizationId) return;
  const key = `${account.id}:${account.turnkeyResourceId}`;
  if (confirmed.has(key)) return;
  try {
    const externalUserId = await getExternalUserId();
    const client = await getClient();
    const listed = await client.listTurnkeyWallets(externalUserId);
    const wallets = listed.wallets ?? [];
    if (wallets.some((wallet) => wallet.id === account.turnkeyResourceId)) {
      confirmed.add(key);
      return;
    }
    const match = pickHubResource(
      {
        turnkeyResourceId: account.turnkeyResourceId,
        organizationId: account.organizationId,
        publicKeyHex: account.publicKeyHex,
      },
      wallets,
    );
    if (!match) return;
    const previousId = account.id;
    account.id = match.id;
    account.turnkeyResourceId = match.id;
    confirmed.add(`${account.id}:${account.turnkeyResourceId}`);
    await walletStore.updateAccount(previousId, {
      id: match.id,
      turnkeyResourceId: match.id,
    });
  } catch {
    /* listing can fail closed; the signing call still reports the hub error */
  }
}

/**
 * Hub resource id to store at the end of email recovery.
 * Prefers the id verify returned. Older hubs omit it; the wallet
 * list still has both ids, and recovery used to keep the wrong one.
 */
export async function resolveRecoveredHubResourceId(input: {
  resourceId: string | null;
  walletId: string | null;
  organizationId: string;
  publicKeyHex: string | null;
  externalUserId: string | null;
}): Promise<string> {
  if (input.resourceId) return input.resourceId;
  if (!input.externalUserId) {
    throw new Error(
      "Could not find this wallet on your account. Request a new code and try again.",
    );
  }
  await walletStore.setInstallId(input.externalUserId);
  const client = await getClient();
  const listed = await client.listTurnkeyWallets(input.externalUserId);
  const match = pickHubResource(
    {
      turnkeyResourceId: input.walletId ?? "",
      organizationId: input.organizationId,
      publicKeyHex: input.publicKeyHex ?? "",
    },
    listed.wallets ?? [],
  );
  if (!match) {
    throw new Error(
      "Could not find this wallet on your account. Request a new code and try again.",
    );
  }
  return match.id;
}
