import {
  AppState,
  DEFAULT_STATE,
  WalletAccount,
  NetworkId,
  ConnectedSite,
  RecentRecipient,
  RecipientAsset,
  Contact,
  SitePermissions,
  DEFAULT_SITE_PERMISSIONS,
  MAX_RECENT_RECIPIENTS,
  MAX_CONTACTS,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_HUB_BASE_URL,
  DEFAULT_HUB_API_KEY,
  isAllowedHubBaseUrl,
  isExternalAccount,
} from "./types";
import { deriveArchAccountAddress } from "../utils/sdk";
import { INDEXER_BASE_URL, DEFAULT_INDEXER_API_KEY } from "../utils/explorer-config";
import { applyDiagnosticsRuntime } from "../utils/log";
import { keystore, KeystoreLockedError } from "../crypto/keystore";
import { sessionManager } from "../session/SessionManager";
import { passkeyBootstrap } from "../session/bootstrap-passkey";
import { EmailBootstrap, type EmailBootstrapArgs } from "../session/bootstrap-email";
import { ensureHubSession } from "../utils/hub-session";
import { clearAllHubTokens } from "../utils/hub-session-store";

const LEGACY_EC2_HUB_BASE_URL = "http://44.222.123.237:3005";
/**
 * Old chrome-wallet builds shipped a literal hub API key in source.
 * That key has been rotated; this constant is kept ONLY so the
 * migration in `migrateApiConfig` can recognize and overwrite stale
 * values still sitting in users' encrypted state on upgrade. Do not
 * use this for any new requests.
 */
const LEGACY_HUB_API_KEY = "D3DqTHT1JgTAzyYWiZmZ0KWjKJ-f_Tiilw_VtrW9Wog";
const ROTATED_LEAKED_HUB_API_KEY = "OZfoD0ZJh6kQpd3Lr4TvLbnocS2g_eooZlQ7VEfbE4M";

/**
 * The Indexer API key shipped hardcoded in `explorer-config.ts` for
 * extension builds v0.1.5 – v0.2.0 (commit fa31425 → f060c54). It
 * was removed from source in May 2026 (f060c54) and rotated at the
 * Indexer admin, but every install from that era still has the
 * leaked value sitting in their encrypted wallet state. The
 * lookup `state.indexerApiKey || DEFAULT_INDEXER_API_KEY` picks
 * the persisted (leaked) one over the build-time (rotated) one,
 * so those users now share a quota with every leaked-bundle in
 * the wild and get rate-limited on basic reads (BTC history,
 * Arch RPC, fee estimates).
 *
 * Mirroring the LEGACY_HUB_API_KEY / ROTATED_LEAKED_HUB_API_KEY
 * pattern: we keep the literal here so the migration in
 * migrateApiConfig can recognize and snap it forward to the
 * current build-time default. Do not use this constant for any
 * new requests.
 */
export const LEAKED_INDEXER_API_KEY =
  "arch_live_28FvKem4QudQx0uczFunu4plqIo1rwWpiajtkrkj2PVhSllF";
const INSTALL_ID_KEY = "arch_wallet_install_id";
const HAS_RECOVERABLE_ACCOUNT_HINT_KEY = "arch_wallet_has_recoverable_account_hint";

/**
 * Public hint -- "does the locked keystore contain at least one
 * Turnkey-backed (passkey / email) wallet?" Stored outside the
 * keystore in `chrome.storage.local` so the Unlock screen, which
 * sees only a sealed keystore, can decide whether to render the
 * "Recover via email" CTA.
 *
 * Why this exists: the email-OTP recovery flow only does anything
 * useful for Turnkey wallets. Linked external wallets (Xverse /
 * UniSat) have no Hub-side recovery -- their keys live in the
 * external wallet, not in our sub-org -- so showing them a "Recover
 * via email" CTA on Unlock just leads to a dead-end "no candidates
 * for this email" screen.
 *
 * Privacy: this leaks one bit ("has the user ever onboarded a
 * passkey/email wallet on this device"). That's strictly less than
 * what the install id already discloses to anything with
 * chrome.storage.local read access, so the trade-off is acceptable.
 *
 * Fail-open semantics: missing hint -> assume true (show the CTA).
 * That preserves the previous behavior for installs that predate
 * this hint, so we never accidentally strip recovery from someone
 * who actually needs it.
 */
async function writeRecoverableAccountHint(state: AppState | null): Promise<void> {
  try {
    if (state === null) {
      await chrome.storage.local.remove(HAS_RECOVERABLE_ACCOUNT_HINT_KEY);
      return;
    }
    const hasRecoverable = state.accounts.some(
      (a) => a.kind !== "external",
    );
    await chrome.storage.local.set({
      [HAS_RECOVERABLE_ACCOUNT_HINT_KEY]: hasRecoverable,
    });
  } catch {
    /* best-effort hint; never block the real keystore write on it */
  }
}

export async function hasRecoverableAccountHint(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(HAS_RECOVERABLE_ACCOUNT_HINT_KEY);
    const value = result?.[HAS_RECOVERABLE_ACCOUNT_HINT_KEY];
    if (typeof value === "boolean") return value;
    // No hint yet (legacy install / first run) -> fail open so we
    // never accidentally hide recovery from a passkey/email user.
    return true;
  } catch {
    return true;
  }
}

async function getOrCreateInstallId(): Promise<string> {
  try {
    const result = await chrome.storage.local.get(INSTALL_ID_KEY);
    const existing = result?.[INSTALL_ID_KEY];
    if (typeof existing === "string" && existing.length > 0) return existing;
    const id =
      self.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
    return id;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

async function loadPlaintextState(): Promise<AppState | null> {
  const raw = (await keystore.read()) as Partial<AppState> | null;
  if (!raw) return null;
  return { ...DEFAULT_STATE, ...raw };
}

async function savePlaintextState(state: AppState): Promise<void> {
  await keystore.write(state);
  // Keep the public recoverable-account hint in sync with every
  // keystore write so the Unlock screen never gets stale gating
  // information. Best-effort: hint write failures don't fail the
  // real save.
  void writeRecoverableAccountHint(state);
}

/**
 * One-shot migration from the legacy single-API config (apiBaseUrl/apiKey,
 * which targeted the Wallet Hub) to the new split config:
 *   - hubBaseUrl/hubApiKey   -> Turnkey + signing-requests + custodial BTC
 *   - indexerBaseUrl/indexerApiKey -> Arch Explorer Indexer (reads, faucet, BTC, RPC)
 */
export function migrateApiConfig(state: any): boolean {
  let migrated = false;

  if (state.apiBaseUrl !== undefined || state.apiKey !== undefined) {
    if (!state.hubBaseUrl) state.hubBaseUrl = state.apiBaseUrl || DEFAULT_HUB_BASE_URL;
    if (!state.hubApiKey) state.hubApiKey = state.apiKey || DEFAULT_HUB_API_KEY;
    delete state.apiBaseUrl;
    delete state.apiKey;
    migrated = true;
  }

  if (!state.hubBaseUrl) {
    state.hubBaseUrl = DEFAULT_HUB_BASE_URL;
    migrated = true;
  } else if (state.hubBaseUrl === LEGACY_EC2_HUB_BASE_URL) {
    state.hubBaseUrl = DEFAULT_HUB_BASE_URL;
    migrated = true;
  } else if (!isAllowedHubBaseUrl(state.hubBaseUrl)) {
    // Defence-in-depth: a pre-allowlist build may have persisted an
    // arbitrary Hub URL the user typed into Settings. Snap it back
    // on read so any subsequent Hub call goes to a vetted host.
    // This covers both legacy installs and the "user pasted a
    // phishing URL between releases" case.
    state.hubBaseUrl = DEFAULT_HUB_BASE_URL;
    migrated = true;
  }
  if (!state.hubApiKey) {
    state.hubApiKey = DEFAULT_HUB_API_KEY;
    migrated = true;
  } else if (
    state.hubApiKey === LEGACY_HUB_API_KEY ||
    state.hubApiKey === ROTATED_LEAKED_HUB_API_KEY
  ) {
    state.hubApiKey = DEFAULT_HUB_API_KEY;
    migrated = true;
  }

  if (!state.indexerBaseUrl) {
    state.indexerBaseUrl = INDEXER_BASE_URL;
    migrated = true;
  }
  if (!state.indexerApiKey) {
    state.indexerApiKey = DEFAULT_INDEXER_API_KEY;
    migrated = true;
  } else if (state.indexerApiKey === LEAKED_INDEXER_API_KEY) {
    // Snap users off the v0.1.5–v0.2.0 hardcoded key that shipped
    // publicly in the wild. Anyone still on it is sharing quota
    // with every leaked bundle and seeing rate-limited reads.
    state.indexerApiKey = DEFAULT_INDEXER_API_KEY;
    migrated = true;
  }

  return migrated;
}

/**
 * Run all account- and config-shape migrations once on read. Called
 * both from getState (for legacy installs) and from the seal/unlock
 * paths.
 */
export function migrateState(stateInput: any): { state: AppState; migrated: boolean } {
  const state = { ...DEFAULT_STATE, ...stateInput };
  let migrated = false;

  // v5 -> v5.1: drop Magic Eden linked wallets.
  //
  // Magic Eden discontinued their Bitcoin wallet, so any
  // `externalProvider === "magiceden"` rows no longer have a working
  // sign path here. We never controlled the keys for those rows in the
  // first place (they live inside Magic Eden's wallet), so this is a
  // local cleanup -- the user can re-link via Xverse / UniSat if they
  // want a usable wallet on this device. Rebind `activeAccountId` if
  // we just removed whatever was active so the loaded state stays
  // consistent.
  const beforeAccounts = state.accounts.length;
  state.accounts = state.accounts.filter(
    (a: any) => a?.externalProvider !== "magiceden",
  );
  if (state.accounts.length !== beforeAccounts) {
    migrated = true;
    if (
      state.activeAccountId &&
      !state.accounts.some((a: any) => a.id === state.activeAccountId)
    ) {
      state.activeAccountId = state.accounts[0]?.id ?? null;
    }
  }

  for (const acct of state.accounts) {
    if (!acct.kind) {
      acct.kind = "turnkey";
      migrated = true;
    }
    // v3 -> v4: derive authMethod from the deprecated isCustodial flag.
    //
    // Naïve mapping (which we previously shipped) was:
    //   isCustodial === true  -> "email"
    //   isCustodial === false -> "passkey"
    //
    // That's wrong for legacy custodial wallets: those used parent-org
    // server-held keys and never had an email registered on Turnkey,
    // so blanket-promoting them to "email" lands the user in a
    // SessionBootstrapper they can't escape (no email -> no OTP ->
    // no session). The new mapping is:
    //
    //   isCustodial === true  + recoveryEmail set      -> "email"
    //   isCustodial === true  + recoveryEmail absent   -> "passkey" *
    //   isCustodial === false                          -> "passkey"
    //
    // (*) Passkey is the least-broken default for orphaned legacy
    //     custodial wallets -- they don't HAVE a passkey either, but
    //     this path lets the wallet load to the dashboard where the
    //     user can pick "Forget this wallet" or "Recover via email"
    //     instead of being trapped on the email-OTP gate. Long term,
    //     a dedicated "orphan" authMethod with a focused "this wallet
    //     predates the new auth model -- re-create" screen would be
    //     better than smuggling it under "passkey".
    if (!acct.authMethod) {
      if ((acct as any).isCustodial === true && acct.recoveryEmail) {
        acct.authMethod = "email";
      } else {
        acct.authMethod = "passkey";
      }
      migrated = true;
    }
    if ((acct as any).isCustodial !== undefined) {
      delete (acct as any).isCustodial;
      migrated = true;
    }
    if (acct.kind === "external" && acct.authMethod !== "external") {
      acct.authMethod = "external";
      migrated = true;
    }
    if (!acct.archAddress && acct.publicKeyHex && acct.publicKeyHex.length >= 64) {
      acct.archAddress = deriveArchAccountAddress(acct.publicKeyHex);
      migrated = true;
    }
    // Canonical Arch identity fix (Unisat/external derivation bug): external
    // accounts linked before the fix stored the Hub-echoed archAddress, which
    // was the BIP-341 TWEAKED taproot output key — the wrong Arch account.
    // The canonical identity is deterministically derivable from the wallet's
    // public key, so recompute and repair. The old value is preserved in
    // legacyArchAddress (first value wins) rather than discarded. Idempotent:
    // once archAddress matches the canonical derivation this is a no-op.
    if (acct.kind === "external" && acct.publicKeyHex && acct.publicKeyHex.length >= 64) {
      const canonicalArchAddress = deriveArchAccountAddress(acct.publicKeyHex);
      if (acct.archAddress && acct.archAddress !== canonicalArchAddress) {
        if (!acct.legacyArchAddress) acct.legacyArchAddress = acct.archAddress;
        acct.archAddress = canonicalArchAddress;
        migrated = true;
      }
    }
  }

  if (migrateApiConfig(state)) migrated = true;

  if (state.openAs !== "popup" && state.openAs !== "sidepanel") {
    state.openAs = "popup";
    migrated = true;
  }

  if (!Array.isArray(state.recentRecipients)) {
    state.recentRecipients = [];
    migrated = true;
  }

  if (!Array.isArray(state.contacts)) {
    state.contacts = [];
    migrated = true;
  }

  if (typeof state.autoLockMinutes !== "number" || state.autoLockMinutes <= 0) {
    state.autoLockMinutes = 60;
    migrated = true;
  }

  if (typeof state.sentryOptIn !== "boolean") {
    state.sentryOptIn = false;
    migrated = true;
  }

  if (typeof state.debugMode !== "boolean") {
    state.debugMode = false;
    migrated = true;
  }

  // Per-origin permissions backfill: any pre-permission ConnectedSite
  // gets the safe default (full prompt-required) so existing connections
  // don't silently inherit elevated rights.
  for (const origin of Object.keys(state.connectedSites || {})) {
    const site = state.connectedSites[origin];
    if (!site.permissions) {
      site.permissions = { ...DEFAULT_SITE_PERMISSIONS };
      migrated = true;
    }
  }

  if (typeof state.schemaVersion !== "number" || state.schemaVersion < CURRENT_SCHEMA_VERSION) {
    state.schemaVersion = CURRENT_SCHEMA_VERSION;
    migrated = true;
  }

  return { state: state as AppState, migrated };
}

/**
 * Public-only "shell" state we return when the wallet is locked. It
 * carries just enough information for the App router to decide what UI
 * to show without needing decryption.
 */
function lockedShellState(initialized: boolean): AppState {
  return { ...DEFAULT_STATE, initialized, locked: true };
}

export const walletStore = {
  /**
   * Returns the full plaintext state when the keystore is unlocked, or
   * a locked-shell state when sealed (so the App router can decide to
   * show the Unlock screen vs Onboarding).
   */
  async getState(): Promise<AppState> {
    const sealed = await keystore.isSealed();
    const unlocked = await keystore.isUnlocked();
    if (!sealed) return { ...DEFAULT_STATE };
    if (!unlocked) return lockedShellState(true);
    const raw = (await keystore.read()) as any;
    if (!raw) return lockedShellState(true);
    const { state, migrated } = migrateState(raw);
    state.locked = false;
    if (migrated) await savePlaintextState(state);
    return state;
  },

  /** Read the install id used as the external user id at the Hub. */
  getInstallId(): Promise<string> {
    return getOrCreateInstallId();
  },

  /**
   * Overwrite the local install id. Used by the email-recovery flow:
   * on a fresh device the install id is random, but Hub APIs are keyed
   * to the externalUserId the wallet was originally bound to, so after
   * recovery we re-bind locally so future calls hit the right user.
   * Idempotent.
   */
  async setInstallId(id: string): Promise<void> {
    if (!id) return;
    try {
      await chrome.storage.local.set({ [INSTALL_ID_KEY]: id });
    } catch {
      // Best-effort; if storage is unavailable the install id helper
      // falls back to its random value -- recovery still completes but
      // the user may need to retry connectivity-bound actions.
    }
  },

  async initialize(): Promise<void> {
    // Ensure an install id exists from the very first background boot
    // so per-install scoping is always available downstream.
    await getOrCreateInstallId();
  },

  /**
   * Initial seal during onboarding. Encrypts the provided account into a
   * fresh keystore using the user's password. Returns the unlocked state.
   */
  async completeOnboarding(password: string, account: WalletAccount): Promise<AppState> {
    const initial: AppState = {
      ...DEFAULT_STATE,
      initialized: true,
      locked: false,
      accounts: [account],
      activeAccountId: account.id,
    };
    await keystore.seal(password, initial);
    void writeRecoverableAccountHint(initial);
    return initial;
  },

  /**
   * Migrate a legacy (unencrypted) state blob by sealing it under a
   * fresh password. Used when the user upgrades from a pre-keystore
   * build and is prompted to set a password.
   */
  async sealLegacyState(password: string, legacyState: unknown): Promise<AppState> {
    const { state } = migrateState(legacyState);
    state.locked = false;
    await keystore.seal(password, state);
    void writeRecoverableAccountHint(state);
    return state;
  },

  async addAccount(account: WalletAccount): Promise<void> {
    // Always promote the freshly-added account to active. Sole caller today
    // is the Add Wallet flow (Onboarding addMode), where landing the user
    // on the wallet they just created is the unambiguous expectation. The
    // previous "only set when empty" semantics meant the active selection
    // silently stayed on the previous wallet after every add -- confusing
    // and easy to miss because the list scrolls past the just-created row.
    const state = await this.requireUnlockedState();
    state.accounts.push(account);
    state.activeAccountId = account.id;
    await savePlaintextState(state);
  },

  async setActiveAccount(accountId: string): Promise<void> {
    const state = await this.requireUnlockedState();
    if (state.activeAccountId !== accountId) {
      // Switching accounts means the next sign needs a session bound
      // to the new sub-org. Drop the current one eagerly so we
      // never accidentally stamp on behalf of the wrong wallet.
      await sessionManager.close();
    }
    state.activeAccountId = accountId;
    await savePlaintextState(state);
  },

  /**
   * Remove an account from local state.
   *
   * This is a *local-only* operation: the corresponding sub-org on
   * Turnkey + the resource row in the Hub's `turnkey_resources`
   * table both stay put. We don't have the credentials to delete
   * them, and even if we did we wouldn't want to destroy a wallet
   * the user may later recover via email/passkey re-enrollment.
   * What this removes is the wallet's *presence* on this device.
   *
   * Use cases:
   *   - A legacy custodial wallet that got migrated to
   *     authMethod="email" with no recoveryEmail: irrecoverable from
   *     here, so the user wants to stop seeing it.
   *   - A wallet whose email was rotated outside the app, leaving
   *     the local record bound to an unreachable mailbox.
   *   - Generic "I no longer want this account on this device".
   *
   * Active-account rebinding:
   *   - If the forgotten account was active, promote the first
   *     remaining account, or clear activeAccountId if none remain.
   *   - Close the Turnkey session unconditionally so the *next*
   *     sign starts from a clean slate -- avoids stamping on behalf
   *     of a now-removed account.
   */
  async forgetAccount(accountId: string): Promise<void> {
    const state = await this.requireUnlockedState();
    const before = state.accounts.length;
    state.accounts = state.accounts.filter((a) => a.id !== accountId);
    if (state.accounts.length === before) return; // no-op
    if (state.activeAccountId === accountId) {
      state.activeAccountId = state.accounts[0]?.id ?? null;
    }
    if (state.accounts.length === 0) {
      // Last-wallet removal is an emergency escape hatch. Do not
      // re-encrypt/write an empty keystore here: if the crypto write
      // path or session key is wedged, the user would stay trapped on
      // the email gate. Wiping local wallet state is exactly what
      // "forget this wallet on this device" means when no accounts
      // remain, and it routes the next app boot to Onboarding.
      await keystore.wipe();
      void writeRecoverableAccountHint(null);
      void sessionManager.close().catch(() => {});
      return;
    }

    await savePlaintextState(state);

    // Any in-flight session is now stale. Start cleanup after the
    // account removal is already durable so IndexedDB cleanup can
    // never block the user's escape hatch. `SessionManager.close()`
    // clears its in-memory active-session fields before its first
    // await, so callers stop seeing the removed account immediately
    // even though IndexedDB deletion finishes best-effort later.
    void sessionManager.close().catch(() => {});
  },

  async updateAccount(accountId: string, patch: Partial<WalletAccount>): Promise<void> {
    const state = await this.requireUnlockedState();
    const account = state.accounts.find((a) => a.id === accountId);
    if (!account) return;
    Object.assign(account, patch);
    if (patch.id && state.activeAccountId === accountId) {
      state.activeAccountId = patch.id;
    }
    await savePlaintextState(state);
  },

  async getActiveAccount(): Promise<WalletAccount | null> {
    try {
      const state = await this.requireUnlockedState();
      if (!state.activeAccountId) return null;
      return state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Resolve the account a specific origin should see. Falls back to the
   * globally active account when an origin has no pinned selection.
   */
  async getAccountForOrigin(origin: string): Promise<WalletAccount | null> {
    try {
      const state = await this.requireUnlockedState();
      const site = state.connectedSites[origin];
      const id = site?.accountId || state.activeAccountId;
      if (!id) return null;
      // Match against the internal WalletAccount.id first. Fall back to
      // btcAddress to recover older `connectedSites` entries written by
      // pre-fix builds that mistakenly stored the btcAddress in the
      // `accountId` slot -- without this fallback, every page refresh
      // on those origins would re-prompt the connect popup. When we
      // find the account that way, rewrite the entry so subsequent
      // lookups go through the fast path and forget this ever happened.
      const byId = state.accounts.find((a) => a.id === id);
      if (byId) return byId;
      const byBtc = state.accounts.find((a) => a.btcAddress === id);
      if (byBtc && site && site.accountId !== byBtc.id) {
        site.accountId = byBtc.id;
        savePlaintextState(state).catch(() => {
          /* migration is best-effort; the in-memory match still works */
        });
      }
      return byBtc ?? null;
    } catch {
      return null;
    }
  },

  async setNetwork(network: NetworkId): Promise<void> {
    const state = await this.requireUnlockedState();
    state.network = network;
    await savePlaintextState(state);
  },

  async setAutoLockMinutes(minutes: number): Promise<void> {
    const state = await this.requireUnlockedState();
    state.autoLockMinutes = Math.max(1, Math.round(minutes));
    await savePlaintextState(state);
  },

  async setSentryOptIn(enabled: boolean): Promise<void> {
    const state = await this.requireUnlockedState();
    state.sentryOptIn = enabled;
    await savePlaintextState(state);
    // Take effect immediately in this realm. Other realms (popup vs.
    // background SW) pick this up via their own storage-onChanged
    // listener calling applyDiagnosticsRuntime with the fresh state.
    applyDiagnosticsRuntime({
      debugMode: !!state.debugMode,
      sentryOptIn: enabled,
    });
  },

  async setDebugMode(enabled: boolean): Promise<void> {
    const state = await this.requireUnlockedState();
    state.debugMode = enabled;
    await savePlaintextState(state);
    applyDiagnosticsRuntime({
      debugMode: enabled,
      sentryOptIn: !!state.sentryOptIn,
    });
  },

  async lock(): Promise<void> {
    // Tear the session down first so the IndexedDB key is gone the
    // moment the user (or the auto-lock alarm) locks the wallet.
    // keystore.lock() drops the in-memory plaintext but not the
    // session credential; without this step a stolen device with
    // an extracted IndexedDB blob could still stamp activities for
    // the remaining server-side expiration window.
    await sessionManager.close();
    // Drop any cached Hub session tokens so a re-unlock re-mints rather
    // than reusing a bearer minted for a now-locked wallet.
    await clearAllHubTokens();
    await keystore.lock();
  },

  async unlock(password: string): Promise<AppState> {
    const raw = await keystore.unlock(password);
    const { state, migrated } = migrateState(raw);
    state.locked = false;
    if (migrated) await savePlaintextState(state);
    return state;
  },

  /**
   * Return the session TTL the next `openSession*` call should use.
   * Tied to the user's auto-lock setting (minutes -> seconds), which
   * gives us "the session lives exactly as long as the wallet would
   * stay unlocked anyway." If the user explicitly disabled
   * auto-lock (autoLockMinutes <= 0), we still cap at the
   * MAX_SESSION_TTL_SECONDS hard ceiling via SessionManager.
   */
  sessionTtlSecondsFromState(state: AppState): number {
    const mins = Number.isFinite(state.autoLockMinutes)
      ? Math.max(1, Math.floor(state.autoLockMinutes))
      : 60;
    return mins * 60;
  },

  /**
   * Open a Turnkey IndexedDB session for the active account using
   * the user's existing passkey. Triggers exactly one WebAuthn
   * prompt; subsequent signs within the session window are silent.
   *
   * Resolves with no return value; the session lives in the
   * shared `sessionManager`, and `signerForAccount(...)` picks it
   * up from there.
   */
  async openPasskeySession(): Promise<void> {
    const state = await this.requireUnlockedState();
    const account = state.activeAccountId
      ? state.accounts.find((a) => a.id === state.activeAccountId)
      : null;
    if (!account) throw new Error("No active account to open a session for");
    await this.openPasskeySessionForAccount(account);
  },

  /**
   * Same as `openPasskeySession`, but for an explicitly-named account
   * instead of the currently-active one. The Approve popup needs this:
   * a dapp may have been granted access to account X while the user
   * has since switched the dashboard's active account to Y. Re-opening
   * the session for Y when the dapp wants to sign with X would produce
   * a `SessionLockedError` on the next sign attempt.
   */
  async openPasskeySessionForAccount(account: WalletAccount): Promise<void> {
    if (isExternalAccount(account)) {
      throw new Error("External wallets sign in their source wallet; no Turnkey session is available");
    }
    if (account.authMethod !== "passkey") {
      throw new Error(
        `openPasskeySessionForAccount called for a ${account.authMethod} wallet; use openEmailSession instead`,
      );
    }
    const state = await this.requireUnlockedState();
    await sessionManager.open({
      account,
      ttlSeconds: this.sessionTtlSecondsFromState(state),
      bootstrap: passkeyBootstrap,
    });
    // Phase 2a: opportunistically mint a Hub session token reusing the
    // session we just opened. Fire-and-forget + fail-soft: never blocks
    // or breaks unlock (see utils/hub-session.ts).
    void ensureHubSession(account, state.network);
  },

  /**
   * Open a Turnkey IndexedDB session for the active account using
   * an OTP-derived recovery API key. The caller is responsible for
   * running the `/recovery/email/{init,verify}` flow first and
   * supplying the resulting credentialBundle + ephemeral private
   * key. Both inputs are consumed exactly once; the recovery key
   * never leaves this process.
   */
  async openEmailSession(args: EmailBootstrapArgs): Promise<void> {
    const state = await this.requireUnlockedState();
    const account = state.activeAccountId
      ? state.accounts.find((a) => a.id === state.activeAccountId)
      : null;
    if (!account) throw new Error("No active account to open a session for");
    if (isExternalAccount(account)) {
      throw new Error("External wallets sign in their source wallet; no Turnkey session is available");
    }
    if (account.authMethod !== "email") {
      throw new Error(
        `openEmailSession called for a ${account.authMethod} wallet; use openPasskeySession instead`,
      );
    }
    await sessionManager.open({
      account,
      ttlSeconds: this.sessionTtlSecondsFromState(state),
      bootstrap: new EmailBootstrap(args),
    });
    // Phase 2a: see openPasskeySessionForAccount.
    void ensureHubSession(account, state.network);
  },

  /**
   * Read-only view: does the active account currently have a live
   * session? UI uses this to decide whether the next sign will be
   * silent or will trigger a re-auth (passkey prompt / OTP).
   */
  async hasActiveSession(): Promise<boolean> {
    try {
      const state = await this.requireUnlockedState();
      if (!state.activeAccountId) return false;
      return sessionManager.getClient(state.activeAccountId) !== null;
    } catch {
      return false;
    }
  },

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await keystore.changePassword(oldPassword, newPassword);
  },

  async connectSite(origin: string, site: ConnectedSite): Promise<void> {
    const state = await this.requireUnlockedState();
    state.connectedSites[origin] = {
      ...site,
      permissions: site.permissions ?? { ...DEFAULT_SITE_PERMISSIONS },
    };
    await savePlaintextState(state);
  },

  async setSitePermissions(origin: string, permissions: Partial<SitePermissions>): Promise<void> {
    const state = await this.requireUnlockedState();
    const site = state.connectedSites[origin];
    if (!site) return;
    site.permissions = { ...DEFAULT_SITE_PERMISSIONS, ...site.permissions, ...permissions };
    await savePlaintextState(state);
  },

  async disconnectSite(origin: string): Promise<void> {
    const state = await this.requireUnlockedState();
    delete state.connectedSites[origin];
    await savePlaintextState(state);
  },

  async isSiteConnected(origin: string): Promise<boolean> {
    try {
      const state = await this.requireUnlockedState();
      return origin in state.connectedSites;
    } catch {
      return false;
    }
  },

  async getSitePermissions(origin: string): Promise<SitePermissions | null> {
    try {
      const state = await this.requireUnlockedState();
      const site = state.connectedSites[origin];
      if (!site) return null;
      return site.permissions ?? { ...DEFAULT_SITE_PERMISSIONS };
    } catch {
      return null;
    }
  },

  async setHubConfig(hubBaseUrl: string, hubApiKey: string): Promise<void> {
    if (!isAllowedHubBaseUrl(hubBaseUrl)) {
      // Fail closed in the store, not just the UI. Anything that
      // reaches `setHubConfig` directly (e.g. a future deep-link or
      // background-message-driven write path) must also be gated.
      throw new Error(
        "Refusing to save Hub URL: host not in allowlist. Use the default hub.arch.network or a vetted *.arch.network host.",
      );
    }
    const state = await this.requireUnlockedState();
    state.hubBaseUrl = hubBaseUrl;
    state.hubApiKey = hubApiKey;
    await savePlaintextState(state);
  },

  async setIndexerConfig(indexerBaseUrl: string, indexerApiKey: string): Promise<void> {
    const state = await this.requireUnlockedState();
    state.indexerBaseUrl = indexerBaseUrl;
    state.indexerApiKey = indexerApiKey;
    await savePlaintextState(state);
  },

  async setOpenAs(mode: "popup" | "sidepanel"): Promise<void> {
    const state = await this.requireUnlockedState();
    state.openAs = mode;
    await savePlaintextState(state);
  },

  /**
   * Record a send recipient. Deduplicates by (address, asset, network, mint?)
   * so the same address used multiple times bubbles to the top with an
   * incremented useCount instead of accumulating duplicates.
   */
  async addRecentRecipient(entry: {
    address: string;
    asset: RecipientAsset;
    network: NetworkId;
    mint?: string;
    label?: string;
  }): Promise<void> {
    const state = await this.requireUnlockedState();
    if (!Array.isArray(state.recentRecipients)) state.recentRecipients = [];

    const now = Date.now();
    const trimmedAddress = entry.address?.trim();
    if (!trimmedAddress) return;

    const isSameEntry = (r: RecentRecipient): boolean =>
      r.address === trimmedAddress
      && r.asset === entry.asset
      && r.network === entry.network
      && (r.mint || "") === (entry.mint || "");

    const existing = state.recentRecipients.find(isSameEntry);
    const next: RecentRecipient = existing
      ? {
          ...existing,
          lastUsedAt: now,
          useCount: existing.useCount + 1,
          label: entry.label ?? existing.label,
        }
      : {
          address: trimmedAddress,
          asset: entry.asset,
          network: entry.network,
          mint: entry.mint,
          label: entry.label,
          lastUsedAt: now,
          useCount: 1,
        };

    const others = state.recentRecipients.filter((r) => !isSameEntry(r));
    state.recentRecipients = [next, ...others].slice(0, MAX_RECENT_RECIPIENTS);
    await savePlaintextState(state);
  },

  async removeRecentRecipient(entry: {
    address: string;
    asset: RecipientAsset;
    network: NetworkId;
    mint?: string;
  }): Promise<void> {
    const state = await this.requireUnlockedState();
    if (!Array.isArray(state.recentRecipients)) return;
    state.recentRecipients = state.recentRecipients.filter(
      (r) => !(
        r.address === entry.address
        && r.asset === entry.asset
        && r.network === entry.network
        && (r.mint || "") === (entry.mint || "")
      ),
    );
    await savePlaintextState(state);
  },

  async clearRecentRecipients(): Promise<void> {
    const state = await this.requireUnlockedState();
    state.recentRecipients = [];
    await savePlaintextState(state);
  },

  // Persistent contacts (Phase 2.6)
  async upsertContact(entry: Omit<Contact, "createdAt" | "updatedAt"> & { createdAt?: number }): Promise<void> {
    const state = await this.requireUnlockedState();
    if (!Array.isArray(state.contacts)) state.contacts = [];
    const now = Date.now();
    const idx = state.contacts.findIndex(
      (c) => c.address === entry.address && c.network === entry.network && (c.mint || "") === (entry.mint || ""),
    );
    if (idx >= 0) {
      state.contacts[idx] = {
        ...state.contacts[idx],
        ...entry,
        updatedAt: now,
      };
    } else {
      state.contacts.unshift({
        ...entry,
        createdAt: entry.createdAt ?? now,
        updatedAt: now,
      });
      state.contacts = state.contacts.slice(0, MAX_CONTACTS);
    }
    await savePlaintextState(state);
  },

  async removeContact(entry: { address: string; network: NetworkId; mint?: string }): Promise<void> {
    const state = await this.requireUnlockedState();
    if (!Array.isArray(state.contacts)) return;
    state.contacts = state.contacts.filter(
      (c) => !(c.address === entry.address && c.network === entry.network && (c.mint || "") === (entry.mint || "")),
    );
    await savePlaintextState(state);
  },

  async reset(): Promise<void> {
    await keystore.wipe();
    void writeRecoverableAccountHint(null);
  },

  /**
   * Internal helper that throws if the keystore is locked. Public-facing
   * methods catch the throw and return null/empty values, so callers
   * don't need to special-case the locked state.
   */
  async requireUnlockedState(): Promise<AppState> {
    const raw = (await keystore.read()) as any;
    if (!raw) throw new KeystoreLockedError();
    const { state, migrated } = migrateState(raw);
    state.locked = false;
    if (migrated) await keystore.write(state);
    return state;
  },
};
