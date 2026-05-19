/**
 * SessionManager — owns the lifecycle of a Turnkey IndexedDB-stamped
 * session for the currently active wallet.
 *
 * Design notes
 * ------------
 * 1.  We hold at most one active session at a time, keyed by
 *     `accountId`. Switching accounts rotates the session: close the
 *     old IndexedDB key, mint a new one for the new account. This
 *     matches the "active account" single-pointer model that the
 *     rest of the wallet UI already uses; multi-key parallel
 *     sessions add complexity for no UX win today.
 *
 * 2.  Bootstrap is *not* this class's responsibility. Passkey wallets
 *     register the IndexedDB pub via a WebAuthn-stamped activity,
 *     email wallets via an OTP-derived recovery API key. Both
 *     pathways are abstracted behind `SessionBootstrap`, so this
 *     class never sees credentials -- only "go register this pubkey,
 *     I'll trust the result."
 *
 * 3.  Session expiry has two components: Turnkey enforces it
 *     server-side via `expirationSeconds` on the registered API
 *     key, and we enforce it client-side via `expiresAt`. We treat
 *     anything within `SESSION_EXPIRY_SLACK_SECONDS` of expiry as
 *     already expired so the next sign doesn't fail halfway through
 *     a user action.
 *
 * 4.  `close()` clears the IndexedDB key on the way out. The
 *     corresponding Turnkey API key continues to exist until its
 *     own expirationSeconds runs out -- that's fine because the
 *     private half is now gone from the device and any attempt to
 *     stamp with it would fail. (P5 may add an explicit
 *     DELETE_API_KEYS sweep on lock; not required for safety.)
 *
 * 5.  We deliberately don't subscribe to the wallet-store here.
 *     wallet-store calls open()/close() at the right transitions
 *     (unlock, lock, switch). Keeping the dependency unidirectional
 *     makes the class trivially testable in isolation.
 */

import { IndexedDbStamper } from "@turnkey/indexed-db-stamper";
import { TurnkeyClient } from "@turnkey/http";
import type { WalletAccount } from "../state/types";
import {
  TURNKEY_API_BASE_URL,
  MIN_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  SESSION_EXPIRY_SLACK_SECONDS,
} from "./constants";
import type { SessionBootstrap, SessionStatus } from "./types";

export interface OpenSessionArgs {
  account: WalletAccount;
  /** Desired session TTL. Clamped to [MIN, MAX] by this class. */
  ttlSeconds: number;
  bootstrap: SessionBootstrap;
}

export class SessionManager {
  private stamper: IndexedDbStamper | null = null;
  private currentAccountId: string | null = null;
  private expiresAt: number = 0;
  /**
   * Per-session "openness gate" -- set while an open() is in-flight
   * so concurrent callers don't race to register two API keys.
   */
  private pendingOpen: Promise<TurnkeyClient> | null = null;

  /**
   * Cheap pub/sub for React. We never carry data across the boundary
   * -- subscribers re-read `status()` whenever the version bumps,
   * which keeps the contract identical for in-process consumers and
   * hypothetical cross-context bridges.
   */
  private listeners = new Set<() => void>();
  private version = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot accessor for React's useSyncExternalStore. */
  getVersion = (): number => this.version;

  private notify(): void {
    this.version += 1;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // A misbehaving subscriber must not nuke session lifecycle.
      }
    }
  }

  /**
   * Open (or refresh) a session for `account`. If a valid session
   * for the same account already exists, returns the same client
   * without re-bootstrapping. If a different account's session is
   * open, that one is closed first.
   */
  async open(args: OpenSessionArgs): Promise<TurnkeyClient> {
    const { account, ttlSeconds, bootstrap } = args;
    const ttl = clampTtl(ttlSeconds);

    if (this.pendingOpen) return this.pendingOpen;

    if (
      this.stamper &&
      this.currentAccountId === account.id &&
      this.expiresAt - SESSION_EXPIRY_SLACK_SECONDS * 1000 > Date.now()
    ) {
      return this.buildClient(this.stamper);
    }

    if (this.currentAccountId && this.currentAccountId !== account.id) {
      await this.close();
    }

    this.pendingOpen = this.doOpen(account, ttl, bootstrap);
    try {
      return await this.pendingOpen;
    } finally {
      this.pendingOpen = null;
    }
  }

  private async doOpen(
    account: WalletAccount,
    ttlSeconds: number,
    bootstrap: SessionBootstrap,
  ): Promise<TurnkeyClient> {
    const stamper = new IndexedDbStamper();
    await stamper.init();
    // Always rotate -- a key persisted from a prior session might
    // have been revoked Turnkey-side or be past its expiration.
    // Generating a fresh keypair is cheap (one P-256 in SubtleCrypto)
    // and removes a class of "phantom unlock that fails on first
    // sign" bugs.
    await stamper.resetKeyPair();

    const pubkey = stamper.getPublicKey();
    if (!pubkey) {
      throw new Error("Failed to mint IndexedDB session key");
    }

    try {
      await bootstrap.register({
        account,
        publicKeyHex: pubkey,
        expirationSeconds: ttlSeconds,
      });
    } catch (err) {
      // Bootstrap failed -- don't leave a stale key behind that
      // looks like a session but isn't registered server-side.
      await stamper.clear().catch(() => {});
      throw err;
    }

    this.stamper = stamper;
    this.currentAccountId = account.id;
    this.expiresAt = Date.now() + ttlSeconds * 1000;
    this.notify();
    return this.buildClient(stamper);
  }

  /**
   * Returns the current TurnkeyClient if a session for `accountId`
   * (or the active one, when accountId is omitted) is alive and
   * not within the expiry slack. Returns null otherwise; callers
   * must then `open()` a fresh session.
   */
  getClient(accountId?: string): TurnkeyClient | null {
    if (!this.stamper) return null;
    if (this.expiresAt - SESSION_EXPIRY_SLACK_SECONDS * 1000 <= Date.now()) {
      return null;
    }
    if (accountId && this.currentAccountId !== accountId) return null;
    return this.buildClient(this.stamper);
  }

  status(): SessionStatus {
    return {
      active: this.getClient() !== null,
      accountId: this.currentAccountId,
      expiresAt: this.expiresAt,
    };
  }

  /**
   * Close the current session: clear the IndexedDB key and reset
   * internal state. Safe to call repeatedly, and safe to call from
   * a context that didn't open the session in the first place
   * (e.g. the background service worker locking on the auto-lock
   * alarm). When we don't hold an in-memory stamper reference, we
   * spin up a transient one to perform the on-disk clear -- the
   * extension origin's IndexedDB is shared across popup, sidepanel,
   * and background, so this reliably revokes the session no matter
   * which context first opened it.
   */
  async close(): Promise<void> {
    const stamper = this.stamper;
    const wasActive = this.stamper !== null || this.currentAccountId !== null;
    this.stamper = null;
    this.currentAccountId = null;
    this.expiresAt = 0;
    if (wasActive) this.notify();
    if (stamper) {
      try {
        await stamper.clear();
      } catch {
        // The DB might already be gone (e.g. user manually cleared
        // site data). Either way we no longer hold a reference.
      }
      return;
    }
    if (typeof globalThis.indexedDB === "undefined") return;
    try {
      const fresh = new IndexedDbStamper();
      await fresh.clear();
    } catch {
      // Worst case the session simply ages out via its server-side
      // expirationSeconds; we don't want lock() to throw.
    }
  }

  private buildClient(stamper: IndexedDbStamper): TurnkeyClient {
    return new TurnkeyClient({ baseUrl: TURNKEY_API_BASE_URL }, stamper);
  }
}

function clampTtl(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return MIN_SESSION_TTL_SECONDS;
  if (seconds < MIN_SESSION_TTL_SECONDS) return MIN_SESSION_TTL_SECONDS;
  if (seconds > MAX_SESSION_TTL_SECONDS) return MAX_SESSION_TTL_SECONDS;
  return Math.floor(seconds);
}

/**
 * Process-wide singleton. There's only ever one active wallet at a
 * time, so a single SessionManager is the right granularity. Tests
 * import the class directly to construct fresh instances.
 */
export const sessionManager = new SessionManager();
