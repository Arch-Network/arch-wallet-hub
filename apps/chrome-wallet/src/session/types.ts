import type { WalletAccount } from "../state/types";

/**
 * The thing every bootstrap (passkey or email) must do: take a freshly
 * minted IndexedDB public key and register it as a Turnkey API key on
 * the user's sub-org with a bounded `expirationSeconds`. After this
 * returns the IndexedDB stamper can sign Turnkey activities on behalf
 * of the user until the TTL expires.
 *
 * The bootstrap MUST NOT retain any long-lived secret. For passkey
 * wallets, the stamper for registration is a WebAuthn ceremony that
 * yields no reusable credential. For email wallets, the recovery API
 * key derived from the OTP is used to stamp this one activity and is
 * immediately discarded.
 */
export interface SessionBootstrap {
  /**
   * Brief label exposed for diagnostics / logs. Never sent over the
   * wire to the dapp side.
   */
  readonly id: string;

  register(args: {
    account: WalletAccount;
    /** Compressed P-256 hex from IndexedDbStamper.getPublicKey(). */
    publicKeyHex: string;
    /** Validity window for the new Turnkey API key. */
    expirationSeconds: number;
  }): Promise<void>;
}

/**
 * Snapshot of "is there a usable session for this account right now?"
 * Returned by `SessionManager.status()` so UI can decide whether the
 * next sign will trigger a re-auth prompt.
 */
export interface SessionStatus {
  active: boolean;
  accountId: string | null;
  expiresAt: number; // epoch ms; 0 if no session
}
