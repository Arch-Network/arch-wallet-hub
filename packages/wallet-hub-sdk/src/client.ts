import type {
  WalletHubClientOptions,
  CreateChallengeRequest,
  CreateChallengeResponse,
  VerifyChallengeRequest,
  VerifyChallengeResponse,
  PortfolioResponse,
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
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
}
