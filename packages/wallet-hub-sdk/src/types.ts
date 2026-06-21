export type ArchNetwork = "testnet" | "mainnet";

/**
 * Client construction options.
 *
 * SECURITY model (as of 2026-05 hardening):
 *
 *   - `apiKey` is a *platform* gate (rate-limit + revocation). It is
 *     NOT per-user and shipping it into the browser is by design;
 *     because of that, the API key alone MUST NOT be sufficient to
 *     act on any specific user's behalf.
 *
 *   - Per-user authentication is supplied via `sessionToken`, a
 *     short-lived (default 15 min) bearer token returned by
 *     `verifyWalletLinkChallenge` (after the dApp proved the user
 *     controls their wallet). The Hub enforces that any endpoint
 *     accepting an `externalUserId` must also receive a session
 *     token whose subject matches that `externalUserId`. Without a
 *     session token, only public/wallet-link/recovery endpoints are
 *     usable.
 *
 *   - `baseUrl` MUST be `https://` in production. The constructor
 *     rejects `http://` unless the host is `localhost`/`127.0.0.1`
 *     (developer convenience).
 *
 *   - `fetchImpl` lets test harnesses swap fetch but should not be
 *     used in production code. The shipped client uses the global
 *     `fetch` and reads its own timeout.
 */
export type WalletHubClientOptions = {
  baseUrl: string; // e.g. https://wallet-hub.arch.network/v1
  apiKey?: string; // platform gate; not sufficient for per-user actions
  /**
   * Bearer session token returned by `verifyWalletLinkChallenge`.
   * Pass it (or call `setSessionToken`) before any endpoint that
   * accepts a user-scoped `externalUserId`.
   */
  sessionToken?: string;
  /**
   * Optional signer the client uses to mint (and silently refresh) a
   * per-user session token on demand. When set, money/signing routes
   * (which the Hub enforces a session on) "just work" without the
   * caller managing tokens by hand: the client mints on first need,
   * caches the token, and re-mints once on a session 401. Leave unset
   * to keep the legacy behaviour of supplying `sessionToken` /
   * `setSessionToken` yourself. See {@link SessionSignerSource}.
   */
  sessionSigner?: SessionSignerSource;
  network?: ArchNetwork;
  /**
   * Hard timeout per request in milliseconds. Defaults to 30s.
   * Prevents the dApp from hanging forever if the Hub is degraded.
   */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

// ── Automatic session minting ────────────────────────────────────────────

/**
 * A signer for a Turnkey-custodied wallet. The client requests a
 * challenge, hands you its 32-byte `payloadHex`, and you return a
 * 64-byte (r||s) BIP-340 schnorr signature in lowercase hex, signed
 * with the resource's default Taproot key (HASH_FUNCTION_NO_OP).
 */
export type TurnkeySessionSigner = {
  kind: "turnkey";
  externalUserId: string;
  turnkeyResourceId: string;
  signChallenge: (payloadHex: string) => string | Promise<string>;
};

/**
 * A signer for an external / linked wallet (Xverse, UniSat, ...). The
 * client requests a challenge, hands you its human-readable `message`,
 * and you return the wallet's BIP-322 signature over it (whatever the
 * wallet produces -- typically a base64 witness blob). The `address`
 * must already be linked for `externalUserId` (see
 * `verifyWalletLinkChallenge`).
 */
export type ExternalSessionSigner = {
  kind: "external";
  externalUserId: string;
  walletProvider: string;
  address: string;
  signMessage: (message: string) => string | Promise<string>;
};

export type SessionSigner = TurnkeySessionSigner | ExternalSessionSigner;

/**
 * Either a static signer or a resolver invoked lazily whenever a mint
 * is needed. The resolver form lets a host (e.g. a browser extension)
 * swap the active account without rebuilding the client; return
 * `undefined` when no signer is currently available (the request then
 * proceeds without a freshly-minted token, exactly as before).
 */
export type SessionSignerSource =
  | SessionSigner
  | (() => SessionSigner | undefined | null | Promise<SessionSigner | undefined | null>);

// ── Wallet linking (dapp connect) ────────────────────────────────────────

export type CreateChallengeRequest = {
  externalUserId: string;
  walletProvider: string;
  address: string; // taproot
  network?: string;
};

export type CreateChallengeResponse = {
  challengeId: string;
  message: string;
  expiresAt: string;
};

export type VerifyChallengeRequest = {
  externalUserId: string;
  challengeId: string;
  signature: string;
  schemeHint?: "bip322" | "wallet_specific";
};

export type VerifyChallengeResponse = {
  linkedWalletId: string;
  address: string;
  archAccountAddress: string;
  walletProvider: string;
  verificationScheme: string;
};

// ── Turnkey ──────────────────────────────────────────────────────────────

export type TurnkeyConfigResponse = {
  organizationId: string;
  apiBaseUrl: string;
};

export type CreateTurnkeyWalletRequest = {
  externalUserId: string;
  walletName?: string;
  addressFormat?: string;
  derivationPath?: string;
  /** Optional recovery email captured at onboarding. */
  userEmail?: string;
};

export type CreateTurnkeyPasskeyWalletRequest = CreateTurnkeyWalletRequest & {
  passkey: {
    challenge: string; // base64url
    attestation: unknown;
  };
};

/**
 * Email-only sub-org wallet request. `userEmail` is REQUIRED here --
 * email is the only auth factor at creation time, so we can't omit
 * it the way the passkey request does. The Hub creates a sub-org
 * with `authenticators: []` and `apiKeys: []`; the client
 * bootstraps a permanent session credential later via OTP_AUTH.
 */
export type CreateTurnkeyEmailWalletRequest = {
  externalUserId: string;
  userEmail: string;
  walletName?: string;
  addressFormat?: string;
  derivationPath?: string;
};

// ── Recovery (Phase 1.10) ───────────────────────────────────────────────

export type InitRecoveryEmailRequest = {
  /** Recovery email the user is supplying; the Hub finds matching wallets. */
  email: string;
};

/**
 * One candidate wallet the email matched. The client shows the user
 * the masked label/address; on verify, the user-picked
 * `candidateToken` selects which sub-org receives OTP_AUTH.
 */
export type RecoveryEmailCandidate = {
  /** Opaque, scoped to this challenge. Echo back at verify. */
  candidateToken: string;
  /** Hub resource id for the wallet this candidate unlocks. */
  resourceId?: string;
  walletLabel: string;
  addressMasked: string;
  /** Full default BTC address, returned only to authenticated app clients. */
  defaultAddress?: string | null;
  /** Creation timestamp for display when one email has multiple wallets. */
  createdAt: string;
  /**
   * Kept on the wire for backwards compatibility with older SDK
   * consumers; always `false` since parent-org wallets are filtered
   * out server-side. New clients should branch on `authMethod`.
   *
   * @deprecated Use {@link RecoveryEmailCandidate.authMethod}.
   */
  isCustodial: boolean;
  /**
   * Tells the client what to do after `verifyRecoveryEmail` succeeds:
   *
   * - "passkey": the recovered API key targets a sub-org that already
   *   has authenticators. Stamp `CREATE_AUTHENTICATORS` to register
   *   a new WebAuthn credential on a fresh device.
   * - "email":  the sub-org has only API keys. Use the recovered
   *   bundle to bootstrap an IndexedDB session via STAMP_LOGIN.
   */
  authMethod: "passkey" | "email";
};

export type InitRecoveryEmailResponse = {
  /** Opaque correlation id the verify call must echo back. */
  challengeId: string;
  /**
   * Empty array when no wallet matched (anti-enumeration) or when the
   * rate limit was hit. The UI must show neutral copy in that case.
   */
  candidates: RecoveryEmailCandidate[];
  /** Convenience copy of where the OTP was sent (masked). */
  emailMasked: string;
  expiresAt: string;
};

export type StartRecoveryEmailOtpRequest = {
  challengeId: string;
  candidateToken: string;
  email: string;
};

export type StartRecoveryEmailOtpResponse = {
  emailMasked: string;
  expiresAt: string;
};

export type VerifyRecoveryEmailRequest = {
  challengeId: string;
  /** Token from the candidate the user picked at init. */
  candidateToken: string;
  /** One-time code from the user's email. */
  code: string;
  /**
   * 65-byte hex (0x04-prefixed uncompressed P-256). The Hub asks
   * Turnkey to encrypt the recovery API key bundle to this key; the
   * client HPKE-decrypts using the private half.
   */
  ephemeralPublicKey: string;
  /** Case (a) only: if the client knows its externalUserId, the
   *  Hub will reject when it disagrees with the candidate's user. */
  externalUserId?: string;
};

export type VerifyRecoveryEmailResponse = {
  /**
   * HPKE-encrypted P-256 private key payload. The client decrypts it
   * using @turnkey/crypto and uses the recovered keypair as a one-shot
   * API-key stamper to call CREATE_AUTHENTICATORS against the sub-org.
   */
  credentialBundle: string;
  /** Sub-org the recovered API key targets. */
  organizationId: string;
  /** Sub-org root user id the new authenticator gets attached to. */
  rootUserId: string | null;
  /** Wallet metadata so the client can rebuild a WalletAccount. */
  walletId: string | null;
  defaultAddress: string | null;
  defaultPublicKeyHex: string | null;
  /** externalUserId the wallet was originally bound to. */
  externalUserId: string | null;
  /**
   * Tells the client what to do with the recovered API key bundle.
   * See {@link RecoveryEmailCandidate.authMethod} for semantics.
   * Required field as of /v1/recovery API v2; older Hub deployments
   * predating migration 011 may still omit it -- in that case treat
   * it as "passkey" since email wallets did not exist yet.
   */
  authMethod: "passkey" | "email";
  /** Seconds until the recovery API key expires; usually 900 (15 min). */
  expiresInSeconds: number;
};

// ── Bitcoin ─────────────────────────────────────────────────────────────

/**
 * Build an unsigned PSBT on the server using the indexer's UTXO
 * snapshot. The client signs locally with its session-stamped signer
 * and either broadcasts via its own indexer client or POSTs the
 * resulting raw tx hex to `/btc/broadcast`.
 */
export type BuildBtcPsbtRequest = {
  externalUserId: string;
  turnkeyResourceId: string;
  toAddress: string;
  amountSats: number;
  feeRate?: number;
};

export type BuildBtcPsbtResponse = {
  /** Hex-encoded, *unsigned* PSBT. */
  unsignedPsbtHex: string;
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  feeSats: number;
  feeRate: number;
  inputCount: number;
  changeSats: number;
};

export type BroadcastBtcRequest = {
  /** Hex-encoded, finalised tx (NOT a PSBT). */
  signedTxHex: string;
};

export type BroadcastBtcResponse = {
  txid: string;
};

export type EstimateBtcFeeRequest = {
  externalUserId: string;
  turnkeyResourceId: string;
  toAddress: string;
  amountSats: number;
};

export type EstimateBtcFeeResponse = {
  feeSats: number;
  feeRate: number;
  inputCount: number;
  changeSats: number;
};

export type RegisterExistingPasskeyWalletRequest = {
  externalUserId: string;
  organizationId: string;
  defaultAddress: string;
  defaultPublicKeyHex: string;
  label?: string;
};

export type RegisterExistingPasskeyWalletResponse = {
  resourceId: string;
  userId: string;
  externalUserId: string;
  organizationId: string;
  defaultAddress: string;
  defaultPublicKeyHex: string;
};

export type CreateTurnkeyWalletResponse = {
  resourceId: string;
  userId: string;
  externalUserId: string;
  organizationId: string;
  walletId: string;
  addresses: string[];
  defaultAddress: string | null;
  defaultPublicKeyHex: string | null;
  activityId: string;
};

export type GetTurnkeyWalletResponse = {
  id: string;
  userId: string | null;
  externalUserId: string | null;
  organizationId: string;
  turnkeyRootUserId: string | null;
  walletId: string | null;
  defaultAddress: string | null;
  defaultAddressFormat: string | null;
  defaultDerivationPath: string | null;
  createdAt: string;
  /**
   * @deprecated Always derived from `organizationId === rootOrgId`;
   *             new clients should branch on `authMethod`.
   */
  isCustodial?: boolean;
  /**
   * "passkey" (sub-org with authenticators) or "email" (sub-org
   * with API keys only). `null` for legacy parent-org rows from
   * the deprecated custodial model.
   */
  authMethod: "passkey" | "email" | null;
};

export type ListTurnkeyWalletsResponse = {
  externalUserId: string;
  userId: string | null;
  wallets: GetTurnkeyWalletResponse[];
};

export type RegisterTurnkeyIndexedDbKeyRequest = {
  externalUserId: string;
  resourceId: string;
  publicKey: string;
  apiKeyName?: string;
  expirationSeconds?: string;
};

export type RegisterTurnkeyIndexedDbKeyResponse = {
  resourceId: string;
  organizationId: string;
  turnkeyUserId: string;
  apiKeyIds: string[];
  activityId: string;
};

// ── Signing requests ─────────────────────────────────────────────────────

export type CreateSigningRequest = {
  externalUserId: string;
  signer:
    | { kind: "external"; taprootAddress: string; publicKeyHex?: string }
    | { kind: "turnkey"; resourceId: string };
  action:
    | { type: "arch.transfer"; toAddress: string; lamports: string }
    | { type: "arch.token_transfer"; mintAddress: string; toAddress: string; amount: string; sourceTokenAccount?: string; decimals?: number }
    | { type: "arch.anchor"; btcTxid: string; vout: number }
    | { type: "arch.sign_message"; messageHex: string };
};

export type CreateSigningResponse = {
  signingRequestId: string;
  status: string;
  actionType: string;
  payloadToSign: unknown;
  display: unknown;
  /**
   * sha256 hex digest of the canonical-JSON `display` object as the
   * server stored it. The UI MUST recompute this digest from the
   * `display` it actually renders and compare against this field
   * before showing a "Sign" button -- mismatch means the rendered
   * preview drifted from what's about to be signed (blind-sign
   * defence).
   */
  displayHash: string;
  expiresAt: string | null;
};

export type SigningRequestReadiness =
  | {
      status: "ready";
      reason?: string;
      anchoredUtxo?: { txid: string; vout: number };
      btcAccountAddress?: string;
      confirmations?: number;
      requiredConfirmations?: number;
    }
  | {
      status: "not_ready";
      reason?: string;
      anchoredUtxo?: { txid: string; vout: number };
      btcAccountAddress?: string;
      confirmations?: number;
      requiredConfirmations?: number;
    }
  | {
      status: "unknown";
      reason?: string;
      anchoredUtxo?: { txid: string; vout: number };
      btcAccountAddress?: string;
      confirmations?: number;
      requiredConfirmations?: number;
    };

export type GetSigningRequestResponse = {
  signingRequestId: string;
  status: string;
  actionType: string;
  payloadToSign: unknown;
  display: unknown;
  /** See `CreateSigningResponse.displayHash`. */
  displayHash: string;
  result: unknown | null;
  error: unknown | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  readiness: SigningRequestReadiness;
};

// ── Portfolio ────────────────────────────────────────────────────────────

/**
 * Lightweight portfolio shape used by `WalletHubClient.getPortfolio`.
 * The previous SDK had a `usePortfolio` hook in the UI package that
 * called `client.getPortfolio(...)` against a method that did not
 * exist; the new method + type close that gap.
 */
export type PortfolioToken = {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  /** Raw on-chain balance as a base-10 string (smallest unit). */
  amount: string;
  /** Human-formatted amount; presentation-only. */
  formattedAmount?: string;
  usdValue?: number;
};

export type PortfolioResponse = {
  address: string;
  archAddress?: string;
  tokens: PortfolioToken[];
  /** Sum of USD values across tokens (when available). */
  totalUsd?: number;
  /** Server-side fetch timestamp; useful for caching/freshness UX. */
  asOf: string;
};

export type SubmitSigningRequest = {
  externalUserId: string;
  signature64Hex?: string;
  signedTransaction?: string;
  turnkeyActivityId?: string;
};

export type SubmitSigningResponse = {
  signingRequestId: string;
  status: string;
  result: unknown;
};

// ── Auth sessions ────────────────────────────────────────────────────────

/**
 * Request the server-side scaffolding to issue a one-shot challenge
 * that the caller can sign as proof-of-control of the user's
 * Turnkey resource. The signing key is the resource's default
 * Taproot xOnly key (32 bytes, BIP-340 schnorr).
 */
export type CreateSessionChallengeRequest = {
  externalUserId: string;
  turnkeyResourceId: string;
};

export type CreateSessionChallengeResponse = {
  challengeId: string;
  /** Human-readable multi-line message kept for audit; not signed directly. */
  message: string;
  /** 32-byte sha256 of `message` expressed as 64 lowercase hex chars. Sign this. */
  payloadHex: string;
  expiresAt: string;
};

export type MintSessionRequest = {
  challengeId: string;
  /** 64-byte schnorr signature over `payloadHex`, lowercase hex. */
  signatureHex: string;
};

export type MintSessionResponse = {
  /** Opaque bearer (prefix `whs_v1_`). Returned exactly once. */
  sessionToken: string;
  expiresAt: string;
};

/**
 * Request a proof-of-control challenge for an EXTERNAL (linked /
 * BIP-322) wallet. The `address` must already be linked for
 * `externalUserId`. The returned `message` is what the wallet
 * BIP-322-signs (not a payload hash).
 */
export type CreateExternalSessionChallengeRequest = {
  externalUserId: string;
  walletProvider: string;
  address: string;
};

export type CreateExternalSessionChallengeResponse = {
  challengeId: string;
  /** Human-readable message the wallet must BIP-322-sign. */
  message: string;
  expiresAt: string;
};

export type MintExternalSessionRequest = {
  challengeId: string;
  /** BIP-322 signature over the challenge `message` (wallet-produced). */
  signature: string;
};

export type RevokeSessionResponse = {
  revoked: boolean;
};

