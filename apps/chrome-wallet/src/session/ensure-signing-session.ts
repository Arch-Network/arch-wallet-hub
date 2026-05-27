/**
 * Make sure an account has a live Turnkey signing session before a
 * sign call. Used by the Approve popup so the user gets a single
 * WebAuthn prompt (passkey wallets) instead of a `SessionLockedError`
 * the dapp would then surface as "your wallet is locked".
 *
 * Behaviour by account type:
 *   - external  → no-op; signs in the source wallet, no Turnkey
 *                 session involved.
 *   - passkey   → fast path if a session is already live (in-memory
 *                 or rehydrated from `chrome.storage.session`).
 *                 Otherwise calls `openPasskeySessionForAccount`,
 *                 which triggers exactly one WebAuthn prompt.
 *   - email     → fast path if a session is already live; otherwise
 *                 throws `EmailSessionNeededError`. The Approve popup
 *                 maps this to actionable copy ("Open the dashboard
 *                 and verify by email") -- the OTP UI is not wired
 *                 into the Approve popup today.
 *
 * Idempotent; safe to call on every sign attempt.
 */
import { sessionManager } from "./SessionManager";
import { walletStore } from "../state/wallet-store";
import { isExternalAccount, type WalletAccount } from "../state/types";

export class EmailSessionNeededError extends Error {
  constructor(public readonly account: WalletAccount) {
    super(
      "This wallet uses email sign-in. Open the Arch Wallet dashboard and verify by email, then approve here.",
    );
    this.name = "EmailSessionNeededError";
  }
}

export async function ensureSigningSessionForAccount(
  account: WalletAccount,
): Promise<void> {
  if (isExternalAccount(account)) return;

  const existing = await sessionManager.ensureClient(account.id);
  if (existing) return;

  if (account.authMethod === "passkey") {
    await walletStore.openPasskeySessionForAccount(account);
    return;
  }

  if (account.authMethod === "email") {
    throw new EmailSessionNeededError(account);
  }

  throw new Error(
    `ensureSigningSessionForAccount: unsupported authMethod "${account.authMethod}"`,
  );
}
