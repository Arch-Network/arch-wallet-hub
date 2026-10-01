import type { AppState, WalletAccount } from "../state/types";

export type OriginSigningAccount =
  | { ok: true; account: WalletAccount }
  | { ok: false; account: WalletAccount | null; reason: string };

/**
 * The account a SIGN_* / SEND_* request from `origin` must be signed
 * with: the one the site was connected to, never a fallback. Signing is
 * refused unless it is also the active account, so the key the dapp was
 * shown at connect time is the key the user sees being used.
 */
export function resolveOriginSigningAccount(
  state: Pick<AppState, "accounts" | "activeAccountId" | "connectedSites">,
  origin: string,
): OriginSigningAccount {
  const site = state.connectedSites[origin];
  if (!site) {
    return { ok: false, account: null, reason: "This site is not connected to Arch Wallet." };
  }
  // btcAddress match: legacy entries stored it in `accountId` (see
  // walletStore.getAccountForOrigin).
  const bound =
    state.accounts.find((a) => a.id === site.accountId) ??
    state.accounts.find((a) => a.btcAddress === site.accountId);
  if (!bound) {
    return {
      ok: false,
      account: null,
      reason: "The wallet this site was connected with is no longer on this device. Reconnect the site to continue.",
    };
  }
  if (bound.id !== state.activeAccountId) {
    return {
      ok: false,
      account: bound,
      reason: `This site is connected to "${bound.label}", which is not your active wallet. Switch to "${bound.label}" and retry from the site.`,
    };
  }
  return { ok: true, account: bound };
}
