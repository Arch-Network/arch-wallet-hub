/**
 * Hub-session minting with one-shot recovery.
 *
 * The mid-transaction Hub session mint runs against whatever Turnkey
 * signing session looks live locally -- one that another extension
 * context may have rotated, or whose Turnkey-side API key aged out.
 * When that mint fails, the fix users discovered by hand was a manual
 * lock/unlock (which rebuilds the signing session and re-mints). This
 * helper performs the same reset programmatically, scoped to the
 * signing session, exactly once: rebuild via `forceFresh`, then
 * re-mint.
 *
 * Shared by the Send and Approve flows so their recovery behaviour
 * can't drift apart.
 */

import { isExternalAccount, type NetworkId, type WalletAccount } from "../state/types";
import { ensureHubSession, type HubSessionResult } from "../utils/hub-session";
import { ensureSigningSessionForAccount } from "./ensure-signing-session";

export interface MintHubSessionOptions {
  /**
   * Invoked right before the one-shot rebuild so the UI can surface
   * progress (the rebuild costs a WebAuthn tap for passkey wallets).
   */
  onRecovery?: () => void;
}

/**
 * Ensure a Hub session token for `account`, recovering once from a
 * mint failure by force-rebuilding the Turnkey signing session.
 *
 * External accounts are never rebuilt: they have no Turnkey session to
 * refresh, and retrying would re-prompt the source wallet. Email
 * wallets propagate `EmailSessionNeededError` from the rebuild so the
 * caller's existing OTP gate takes over.
 */
export async function mintHubSessionWithRecovery(
  account: WalletAccount,
  network: NetworkId,
  opts: MintHubSessionOptions = {},
): Promise<HubSessionResult> {
  const first = await ensureHubSession(account, network);
  if (first !== "failed" || isExternalAccount(account)) return first;

  opts.onRecovery?.();
  await ensureSigningSessionForAccount(account, { forceFresh: true });
  return await ensureHubSession(account, network);
}
