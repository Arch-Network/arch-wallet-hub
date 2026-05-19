import type {
  WalletHubClientOptions,
  CreateChallengeRequest,
  CreateChallengeResponse,
  VerifyChallengeRequest,
  VerifyChallengeResponse,
  CreateTurnkeyWalletResponse,
  CreateTurnkeyPasskeyWalletRequest,
  CreateTurnkeyEmailWalletRequest,
  RegisterExistingPasskeyWalletRequest,
  RegisterExistingPasskeyWalletResponse,
  GetTurnkeyWalletResponse,
  ListTurnkeyWalletsResponse,
  RegisterTurnkeyIndexedDbKeyRequest,
  RegisterTurnkeyIndexedDbKeyResponse,
  CreateSigningRequest,
  CreateSigningResponse,
  GetSigningRequestResponse,
  SubmitSigningRequest,
  SubmitSigningResponse,
  BuildBtcPsbtRequest,
  BuildBtcPsbtResponse,
  BroadcastBtcRequest,
  BroadcastBtcResponse,
  TurnkeyConfigResponse,
  InitRecoveryEmailRequest,
  InitRecoveryEmailResponse,
  StartRecoveryEmailOtpRequest,
  StartRecoveryEmailOtpResponse,
  VerifyRecoveryEmailRequest,
  VerifyRecoveryEmailResponse,
  EstimateBtcFeeRequest,
  EstimateBtcFeeResponse
} from "./types.js";

/**
 * Wallet Hub client.
 *
 * Scope after the Indexer migration:
 *   - Turnkey config + wallet management
 *   - Wallet-link challenge/verify (dapp connect flow)
 *   - Signing requests (create / get / submit / sign-with-turnkey)
 *   - Custodial BTC send (`/btc/send`)
 *
 * Reads, BTC PSBT building, and broadcasts now live on the extension/SDK side
 * via the Arch Explorer Indexer (see `apps/chrome-wallet/src/utils/indexer.ts`).
 */
export class WalletHubClient {
  private baseUrl: string;
  private apiKey: string | undefined;
  private network: string;
  private fetchImpl: typeof fetch;

  constructor(opts: WalletHubClientOptions) {
    const trimmed = opts.baseUrl.replace(/\/+$/, "");
    this.baseUrl = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
    this.apiKey = opts.apiKey;
    this.network = opts.network ?? "testnet";
    const f = (opts.fetchImpl ?? fetch) as any;
    this.fetchImpl = typeof f?.bind === "function" ? f.bind(globalThis) : f;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    if (this.network) headers.set("x-network", this.network);
    if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WalletHub error ${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as T;
  }

  // ── Wallet linking (dapp connect challenge / verify) ─────────────────────

  async createWalletLinkChallenge(body: CreateChallengeRequest): Promise<CreateChallengeResponse> {
    return await this.requestJson("/wallet-links/challenge", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async verifyWalletLinkChallenge(body: VerifyChallengeRequest): Promise<VerifyChallengeResponse> {
    return await this.requestJson("/wallet-links/verify", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  // ── Turnkey ──────────────────────────────────────────────────────────────

  async getTurnkeyConfig(): Promise<TurnkeyConfigResponse> {
    return await this.requestJson(`/turnkey/config`);
  }

  async createTurnkeyPasskeyWallet(params: {
    idempotencyKey: string;
    body: CreateTurnkeyPasskeyWalletRequest;
  }): Promise<CreateTurnkeyWalletResponse> {
    return await this.requestJson(`/turnkey/passkey-wallets`, {
      method: "POST",
      headers: { "idempotency-key": params.idempotencyKey },
      body: JSON.stringify(params.body)
    });
  }

  /**
   * Create a new email-only sub-org wallet. The created sub-org has
   * no authenticators or pre-attached API keys; the client must
   * bootstrap a session credential later via the
   * `/recovery/email/{init,verify}` flow before it can sign.
   */
  async createTurnkeyEmailWallet(params: {
    idempotencyKey: string;
    body: CreateTurnkeyEmailWalletRequest;
  }): Promise<CreateTurnkeyWalletResponse> {
    return await this.requestJson(`/turnkey/email-wallets`, {
      method: "POST",
      headers: { "idempotency-key": params.idempotencyKey },
      body: JSON.stringify(params.body),
    });
  }

  async registerExistingPasskeyWallet(
    body: RegisterExistingPasskeyWalletRequest
  ): Promise<RegisterExistingPasskeyWalletResponse> {
    return await this.requestJson(`/turnkey/passkey-wallets/import`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async listTurnkeyWallets(externalUserId: string): Promise<ListTurnkeyWalletsResponse> {
    const q = new URLSearchParams({ externalUserId });
    return await this.requestJson(`/turnkey/wallets?${q.toString()}`);
  }

  async getTurnkeyWallet(params: {
    resourceId: string;
    externalUserId: string;
  }): Promise<GetTurnkeyWalletResponse> {
    const q = new URLSearchParams({ externalUserId: params.externalUserId });
    return await this.requestJson(
      `/turnkey/wallets/${encodeURIComponent(params.resourceId)}?${q.toString()}`
    );
  }

  async registerTurnkeyIndexedDbKey(
    body: RegisterTurnkeyIndexedDbKeyRequest
  ): Promise<RegisterTurnkeyIndexedDbKeyResponse> {
    return await this.requestJson(`/turnkey/indexeddb-keys`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  // ── Signing requests ─────────────────────────────────────────────────────

  async createSigningRequest(body: CreateSigningRequest): Promise<CreateSigningResponse> {
    return await this.requestJson(`/signing-requests`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async getSigningRequest(id: string): Promise<GetSigningRequestResponse> {
    return await this.requestJson(`/signing-requests/${encodeURIComponent(id)}`);
  }

  async submitSigningRequest(id: string, body: SubmitSigningRequest): Promise<SubmitSigningResponse> {
    return await this.requestJson(`/signing-requests/${encodeURIComponent(id)}/submit`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async signWithTurnkey(id: string, body: { externalUserId: string }): Promise<SubmitSigningResponse> {
    return await this.requestJson(`/signing-requests/${encodeURIComponent(id)}/sign-with-turnkey`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  // ── Custodial BTC send (server-side construction + Turnkey signing) ──────

  /**
   * Build an unsigned PSBT server-side using the indexer's UTXO
   * snapshot. The client is then responsible for signing locally
   * (via a session-stamped signer) and broadcasting -- either
   * through {@link broadcastBitcoinTransaction} or its own indexer
   * client.
   */
  async buildBitcoinPsbt(params: BuildBtcPsbtRequest): Promise<BuildBtcPsbtResponse> {
    return await this.requestJson("/btc/build", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  /**
   * Broadcast a finalised, hex-encoded Bitcoin transaction via the
   * Hub's indexer. Useful for SDK consumers that don't ship their
   * own indexer client; the wallet UI broadcasts directly when it
   * already has one.
   */
  async broadcastBitcoinTransaction(
    params: BroadcastBtcRequest
  ): Promise<BroadcastBtcResponse> {
    return await this.requestJson("/btc/broadcast", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  /**
   * Real fee estimate for a custodial send. The server selects UTXOs
   * the same way it would for /btc/send, so the returned fee matches
   * exactly what the user will pay.
   */
  async estimateBitcoinFee(params: EstimateBtcFeeRequest): Promise<EstimateBtcFeeResponse> {
    return await this.requestJson("/btc/estimate-fee", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  // ── Recovery (Email OTP -> add new authenticator) ────────────────────────

  async initRecoveryEmail(body: InitRecoveryEmailRequest): Promise<InitRecoveryEmailResponse> {
    return await this.requestJson(`/recovery/email/init`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async startRecoveryEmailOtp(body: StartRecoveryEmailOtpRequest): Promise<StartRecoveryEmailOtpResponse> {
    return await this.requestJson(`/recovery/email/start`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async verifyRecoveryEmail(body: VerifyRecoveryEmailRequest): Promise<VerifyRecoveryEmailResponse> {
    return await this.requestJson(`/recovery/email/verify`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }
}
