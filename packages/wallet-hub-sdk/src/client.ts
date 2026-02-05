import type {
  WalletHubClientOptions,
  CreateChallengeRequest,
  CreateChallengeResponse,
  VerifyChallengeRequest,
  VerifyChallengeResponse,
  PortfolioResponse,
  CreateTurnkeyWalletRequest,
  CreateTurnkeyWalletResponse,
  CreateTurnkeyPasskeyWalletRequest,
  GetTurnkeyWalletResponse,
  ListTurnkeyWalletsResponse,
  AirdropArchAccountRequest,
  AirdropArchAccountResponse,
  RegisterTurnkeyIndexedDbKeyRequest,
  RegisterTurnkeyIndexedDbKeyResponse,
  CreateSigningRequest,
  CreateSigningResponse,
  GetSigningRequestResponse,
  SubmitSigningRequest,
  SubmitSigningResponse
} from "./types.js";

export class WalletHubClient {
  private baseUrl: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(opts: WalletHubClientOptions) {
    // The Wallet Hub API is versioned under `/v1`. Make the SDK resilient by accepting:
    // - baseUrl = http://localhost:3005
    // - baseUrl = http://localhost:3005/v1
    // and always normalizing to a `/v1` base.
    const trimmed = opts.baseUrl.replace(/\/+$/, "");
    this.baseUrl = /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
    this.apiKey = opts.apiKey;
    // In some environments, calling a captured `window.fetch` with a different `this`
    // (e.g. as `this.fetchImpl(...)`) can throw "Illegal invocation".
    // Binding to globalThis keeps the native implementation happy while still allowing
    // callers to override fetchImpl for testing.
    const f = (opts.fetchImpl ?? fetch) as any;
    this.fetchImpl = typeof f?.bind === "function" ? f.bind(globalThis) : f;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", this.apiKey);
    if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WalletHub error ${res.status} ${res.statusText}: ${text}`);
    }
    return (await res.json()) as T;
  }

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

  async getPortfolio(address: string): Promise<PortfolioResponse> {
    return await this.requestJson(`/portfolio/${encodeURIComponent(address)}`);
  }

  async createTurnkeyWallet(params: {
    idempotencyKey: string;
    body: CreateTurnkeyWalletRequest;
  }): Promise<CreateTurnkeyWalletResponse> {
    return await this.requestJson(`/turnkey/wallets`, {
      method: "POST",
      headers: { "idempotency-key": params.idempotencyKey },
      body: JSON.stringify(params.body)
    });
  }

  async listTurnkeyWallets(externalUserId: string): Promise<ListTurnkeyWalletsResponse> {
    const q = new URLSearchParams({ externalUserId });
    return await this.requestJson(`/turnkey/wallets?${q.toString()}`);
  }

  async airdropArchAccount(body: AirdropArchAccountRequest): Promise<AirdropArchAccountResponse> {
    return await this.requestJson(`/arch/accounts/airdrop`, {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  async registerTurnkeyIndexedDbKey(
    body: RegisterTurnkeyIndexedDbKeyRequest
  ): Promise<RegisterTurnkeyIndexedDbKeyResponse> {
    return await this.requestJson(`/turnkey/indexeddb-keys`, {
      method: "POST",
      body: JSON.stringify(body)
    });
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

  async getTurnkeyWallet(params: {
    resourceId: string;
    externalUserId: string;
  }): Promise<GetTurnkeyWalletResponse> {
    const q = new URLSearchParams({ externalUserId: params.externalUserId });
    return await this.requestJson(
      `/turnkey/wallets/${encodeURIComponent(params.resourceId)}?${q.toString()}`
    );
  }

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
}
