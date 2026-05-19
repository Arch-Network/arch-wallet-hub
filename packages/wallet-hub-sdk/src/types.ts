export type ArchNetwork = "testnet" | "mainnet";

export type WalletHubClientOptions = {
  baseUrl: string; // e.g. https://wallet-hub.arch.network/v1
  apiKey?: string; // optional when nginx injects it server-side
  network?: ArchNetwork;
  fetchImpl?: typeof fetch;
};

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
  result: unknown | null;
  error: unknown | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  readiness: SigningRequestReadiness;
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

