import { toXOnlyPubkeyHex } from "../auth/sessionToken.js";
import type { TurnkeyService } from "./client.js";

export type WalletAccountReader = Pick<
  TurnkeyService,
  "getWalletsForOrganization" | "getWalletAccountsForOrganization"
>;

/**
 * Look up `address` + `publicKeyHex` among the wallet accounts Turnkey
 * actually holds for `organizationId`. Returns the owning walletId, or
 * null when Turnkey doesn't know the pair. Any Turnkey error (including
 * an org the Hub's parent org can't read) propagates to the caller.
 */
export async function findTurnkeyWalletAccount(
  turnkey: WalletAccountReader,
  params: { organizationId: string; address: string; publicKeyHex: string }
): Promise<{ walletId: string } | null> {
  const wanted = toXOnlyPubkeyHex(params.publicKeyHex);
  if (!wanted) return null;
  const { wallets } = await turnkey.getWalletsForOrganization({
    organizationId: params.organizationId
  });
  for (const wallet of wallets) {
    const { accounts } = await turnkey.getWalletAccountsForOrganization({
      organizationId: params.organizationId,
      walletId: wallet.walletId
    });
    const match = accounts.find(
      (a) =>
        a.address === params.address &&
        typeof a.publicKey === "string" &&
        toXOnlyPubkeyHex(a.publicKey) === wanted
    );
    if (match) return { walletId: wallet.walletId };
  }
  return null;
}
