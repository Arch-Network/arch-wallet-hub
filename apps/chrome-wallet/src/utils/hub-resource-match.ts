/**
 * Pick the Hub row a locally stored Turnkey account actually is.
 *
 * Recovery used to persist Turnkey's `walletId` as
 * `turnkeyResourceId`. Session mint and signing look the id up as a
 * Hub resource primary key, so that wallet answered
 * `InvalidResource` on every signature. `id` is the Hub key;
 * `walletId` is Turnkey's.
 */
export interface HubResourceMatchInput {
  turnkeyResourceId: string;
  organizationId: string;
  publicKeyHex: string;
}

export interface HubResourceMatchCandidate {
  id: string;
  organizationId: string;
  walletId?: string | null;
  defaultPublicKeyHex?: string | null;
}

/**
 * The row to adopt, or null when the stored id is already the Hub id
 * or no single row is safe to pick.
 */
export function pickHubResource(
  account: HubResourceMatchInput,
  wallets: readonly HubResourceMatchCandidate[],
): HubResourceMatchCandidate | null {
  if (wallets.some((wallet) => wallet.id === account.turnkeyResourceId)) return null;

  const byWalletId = wallets.find(
    (wallet) => !!wallet.walletId && wallet.walletId === account.turnkeyResourceId,
  );
  if (byWalletId) return byWalletId;

  const key = account.publicKeyHex.trim().toLowerCase();
  if (key) {
    const byKey = wallets.find(
      (wallet) => (wallet.defaultPublicKeyHex ?? "").trim().toLowerCase() === key,
    );
    if (byKey) return byKey;
  }

  const byOrg = wallets.filter((wallet) => wallet.organizationId === account.organizationId);
  if (byOrg.length === 1) return byOrg[0]!;
  return null;
}
