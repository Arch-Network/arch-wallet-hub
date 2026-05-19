export type NetworkId = "testnet4" | "mainnet";
export type OpenAsMode = "popup" | "sidepanel";
export type RecipientAsset = "btc" | "arch" | "apl";

/**
 * Bumped whenever the persisted state shape changes in a way that
 * requires a migration. The migration logic in wallet-store.ts checks
 * this and rewrites legacy blobs forward.
 *
 * v3 -> v4: `WalletAccount.isCustodial` replaced with
 * `WalletAccount.authMethod`. Existing accounts:
 *   - isCustodial === true  -> authMethod = "email"  (was parent-org
 *     custodial; functionally unsupported after the IndexedDB-session
 *     migration but kept readable so the UI can surface a "this
 *     wallet type is no longer supported; please re-create" notice)
 *   - isCustodial === false -> authMethod = "passkey"
 */
export const CURRENT_SCHEMA_VERSION = 4;

/**
 * How a wallet authenticates to Turnkey. Both methods produce the
 * same IndexedDB-stored session credential at unlock time; what
 * differs is the *bootstrap*: a passkey wallet stamps the initial
 * session-key-registration activity with WebAuthn, an email wallet
 * stamps it with a short-lived recovery API key minted via OTP_AUTH.
 *
 * "custodial" wallets (parent-org, Hub-signed) are not a value here;
 * that wallet class was removed in the move to "fully user-controlled"
 * sub-org wallets per Turnkey's embedded-wallet production checklist.
 */
export type WalletAuthMethod = "passkey" | "email";

/**
 * A recipient address the user has previously sent to. Surfaced on the Send
 * form as a "Recent" picker so common addresses don't need to be re-pasted.
 *
 * Scoped by (asset, network[, mint for APL]) so we only show relevant
 * addresses for the current send (Bitcoin testnet != Bitcoin mainnet, USDC mint
 * != generic APL transfers).
 */
export interface RecentRecipient {
  address: string;
  asset: RecipientAsset;
  network: NetworkId;
  /** Optional human-readable label (currently unused; reserved for future "Save as contact") */
  label?: string;
  /** For APL transfers we also remember which mint was used. */
  mint?: string;
  lastUsedAt: number;
  useCount: number;
}

/**
 * A persistent labeled contact. Distinct from RecentRecipient in that
 * it's user-curated and survives recents pruning.
 */
export interface Contact {
  address: string;
  label: string;
  network: NetworkId;
  asset?: RecipientAsset;
  mint?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WalletAccount {
  id: string;
  label: string;
  btcAddress: string;
  publicKeyHex: string;
  archAddress?: string;
  turnkeyResourceId: string;
  organizationId: string;
  /** How this wallet bootstraps a Turnkey IndexedDB session. */
  authMethod: WalletAuthMethod;
  /** WebAuthn credential id registered with Turnkey for this passkey wallet. */
  passkeyCredentialId?: string;
  /** Email captured at sign-up for recovery; never sent to dapps. */
  recoveryEmail?: string;
  /**
   * Deprecated legacy flag from an abandoned backup flow.
   * Recovery is now modeled as email OTP re-bootstrap or passkey
   * re-enrollment.
   */
  seedBackedUp?: boolean;
  createdAt: number;
}

/**
 * Per-origin permission set. Default = prompt for everything; users
 * can opt into auto-approvals from the Approve modal or Settings.
 */
export interface SitePermissions {
  /** Allow non-money calls (getAccount, getBalance) without prompt. */
  readState: boolean;
  /** Auto-approve message signing (still asks for fresh user gesture). */
  signMessage: boolean;
  /** Auto-approve transfer/token-transfer. */
  sendTransfer: boolean;
  /** Auto-approve PSBT signing. */
  signPsbt: boolean;
  /** Optional daily spending cap (lamports / sats), enforced by background. */
  spendingLimitSatsPerDay?: number;
}

export const DEFAULT_SITE_PERMISSIONS: SitePermissions = {
  readState: true,
  signMessage: false,
  sendTransfer: false,
  signPsbt: false,
};

export interface AppState {
  /** Persisted schema version. Used by migrations. */
  schemaVersion: number;
  initialized: boolean;
  locked: boolean;
  network: NetworkId;
  activeAccountId: string | null;
  accounts: WalletAccount[];
  connectedSites: Record<string, ConnectedSite>;

  // Wallet Hub API (Turnkey + signing-requests + custodial BTC send)
  hubBaseUrl: string;
  hubApiKey: string;

  // Arch Explorer Indexer API (reads + faucet + BTC + Arch RPC compat)
  indexerBaseUrl: string;
  indexerApiKey: string;

  // How the toolbar icon opens the wallet UI.
  openAs: OpenAsMode;

  // Most-recently-sent-to addresses. Capped to MAX_RECENT_RECIPIENTS entries
  // and stored MRU-first.
  recentRecipients: RecentRecipient[];

  // Persistent labeled contacts.
  contacts: Contact[];

  /** Idle minutes before the wallet auto-locks. Default 15. */
  autoLockMinutes: number;

  /** Opt-in error reporting (Sentry). Off by default. */
  sentryOptIn: boolean;
  /** Toggles verbose console + Settings -> Diagnostics view. */
  debugMode: boolean;
}

export interface ConnectedSite {
  origin: string;
  name?: string;
  iconUrl?: string;
  connectedAt: number;
  accountId: string;
  permissions?: SitePermissions;
}

export const DEFAULT_HUB_BASE_URL =
  ((globalThis as any).__ARCH_WALLET_DEFAULT_HUB_BASE_URL as string | undefined) ||
  "https://hub.arch.network";

/**
 * Default Wallet Hub API key baked into the build.
 *
 * Every Hub request must carry an `X-API-Key`; the value here belongs
 * to the "chrome-wallet" platform app on the deployed Hub. It is NOT
 * a secret in the cryptographic sense -- it's an installation-level
 * gate that lets the Hub revoke a bad release or rate-limit a misbehaving
 * client without per-user provisioning. (Individual wallet auth still
 * happens server-side via Turnkey + sub-org isolation.)
 *
 * If a future build needs a different key (e.g. dev vs prod), set
 * `globalThis.__ARCH_WALLET_DEFAULT_HUB_API_KEY` before this module
 * loads -- the override takes precedence. The wallet-store migration
 * also rewrites stale keys (`LEGACY_HUB_API_KEY` -> this value) so
 * upgrades don't require re-onboarding.
 */
export const DEFAULT_HUB_API_KEY =
  ((globalThis as any).__ARCH_WALLET_DEFAULT_HUB_API_KEY as string | undefined) ||
  "OZfoD0ZJh6kQpd3Lr4TvLbnocS2g_eooZlQ7VEfbE4M";

export const MAX_RECENT_RECIPIENTS = 20;
export const MAX_CONTACTS = 100;

export const DEFAULT_STATE: AppState = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  initialized: false,
  locked: true,
  network: "testnet4",
  activeAccountId: null,
  accounts: [],
  connectedSites: {},
  hubBaseUrl: DEFAULT_HUB_BASE_URL,
  hubApiKey: DEFAULT_HUB_API_KEY,
  indexerBaseUrl: "",
  indexerApiKey: "",
  openAs: "popup",
  recentRecipients: [],
  contacts: [],
  autoLockMinutes: 15,
  sentryOptIn: false,
  debugMode: false,
};
