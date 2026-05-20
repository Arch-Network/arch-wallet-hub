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
  EstimateBtcFeeResponse,
  PortfolioResponse
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Allow-listed hosts that we accept over plain HTTP for dev use. */
const PLAINTEXT_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * Validate the configured base URL. We reject `http://` against
 * anything that isn't an obvious developer host so the SDK can't be
 * accidentally pointed at a plain-text production endpoint (the API
 * key + session token would then be sniffable).
 */
function validateBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`WalletHubClient: invalid baseUrl ${JSON.stringify(raw)}`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && PLAINTEXT_DEV_HOSTS.has(url.hostname)) return url;
  throw new Error(
    `WalletHubClient: baseUrl must use https:// (got ${url.protocol}//${url.hostname}); plain http is only allowed for localhost`,
  );
}

/**
 * Strip developer-noise / stack-tracey fields out of an error body
 * before re-throwing. We don't want a misbehaving server to leak
 * internal paths, env-var hints, or full stacks into a dApp's
 * console / Sentry sink.
 */
function summarizeErrorBody(text: string): string {
  if (!text) return "";
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const msg = typeof j.message === "string" ? j.message : "";
    const code = typeof j.error === "string" ? j.error : "";
    if (msg || code) return [code, msg].filter(Boolean).join(": ");
  } catch {
    /* fall through to plain truncation */
  }
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

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
  private sessionToken: string | undefined;
  private network: string;
  private fetchImpl: typeof fetch;
  private requestTimeoutMs: number;

  constructor(opts: WalletHubClientOptions) {
    const url = validateBaseUrl(opts.baseUrl);
    const trimmed = url.toString().replace(/\/+$/, "");
    this.baseUrl = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
    this.apiKey = opts.apiKey;
    this.sessionToken = opts.sessionToken;
    this.network = opts.network ?? "testnet";
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const f = (opts.fetchImpl ?? fetch) as any;
    this.fetchImpl = typeof f?.bind === "function" ? f.bind(globalThis) : f;
  }

  /**
   * Set / clear the per-user bearer session token (typically obtained
   * from `verifyWalletLinkChallenge`). Pass `undefined` to log out.
   */
  setSessionToken(token: string | undefined): void {
    this.sessionToken = token;
  }

  /** Returns true when a session token is currently set. */
  hasSession(): boolean {
    return Boolean(this.sessionToken);
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.apiKey) headers.set("x-api-key", this.apiKey);
    if (this.sessionToken) {
      // Per-user authn. The Hub treats this as an opaque bearer
      // scoped to one externalUserId + a short TTL.
      headers.set("authorization", `Bearer ${this.sessionToken}`);
    }
    if (this.network) headers.set("x-network", this.network);
    if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? controller.signal,
      });
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(
          `WalletHub request timed out after ${this.requestTimeoutMs}ms: ${path}`,
        );
      }
      throw new Error(`WalletHub network error: ${err?.message ?? String(err)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `WalletHub error ${res.status} ${res.statusText}: ${summarizeErrorBody(text)}`,
      );
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

  // ── Portfolio ────────────────────────────────────────────────────────────

  /**
   * Read a user's portfolio (BTC + token balances + USD totals).
   * Implementation lives behind `/portfolio/:address` on the Hub.
   */
  async getPortfolio(address: string): Promise<PortfolioResponse> {
    return await this.requestJson(
      `/portfolio/${encodeURIComponent(address)}`,
    );
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
    // Defence-in-depth: refuse to ask the server to sign on a user's
    // behalf without a session token bound to that user. The server
    // will also enforce this; the client-side check prevents the
    // wrong assumption from silently shipping into production code.
    if (!this.sessionToken) {
      throw new Error(
        "WalletHubClient.signWithTurnkey requires a session token; call setSessionToken() after verifyWalletLinkChallenge",
      );
    }
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

/**
 * Compute a stable, canonical sha256 hex digest of a `display`
 * payload. Used by both the UI (to verify the rendered preview is
 * the one the server stored) and the API (to populate
 * `displayHash`). Keys are sorted recursively so {"a":1,"b":2} and
 * {"b":2,"a":1} produce the same digest.
 */
export async function computeDisplayHash(display: unknown): Promise<string> {
  const canonical = JSON.stringify(display, sortedReplacer(new WeakSet()));
  const bytes = new TextEncoder().encode(canonical);
  const subtle = (globalThis.crypto?.subtle as SubtleCrypto | undefined);
  if (subtle) {
    const buf = await subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  }
  // Node fallback for SSR / tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require("node:crypto") as typeof import("node:crypto");
  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function sortedReplacer(seen: WeakSet<object>) {
  return function replacer(_key: string, value: unknown): unknown {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (seen.has(value as object)) return null; // break cycles
      seen.add(value as object);
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = obj[k];
      return out;
    }
    return value;
  };
}
