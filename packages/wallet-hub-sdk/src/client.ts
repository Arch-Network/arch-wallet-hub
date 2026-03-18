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
  SubmitSigningResponse,
  WalletOverviewResponse,
  TransactionListResponse,
  TransactionListParams,
  ArchTransactionDetail,
  TokenListResponse,
  TokenInfo,
  NetworkStatsResponse,
  FaucetAirdropResponse,
  BtcAddressSummary,
  BtcUtxo,
  BtcTransaction,
  BtcFeeEstimates,
  SendBtcRequest,
  SendBtcResponse,
  PrepareBtcSendRequest,
  PrepareBtcSendResponse,
  FinalizeBtcRequest,
  FinalizeBtcResponse,
  TurnkeyConfigResponse,
  AccountTokensResponse
} from "./types.js";

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

  async getTurnkeyConfig(): Promise<TurnkeyConfigResponse> {
    return await this.requestJson(`/turnkey/config`);
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

  // ── Wallet Overview (aggregated dashboard) ──

  async getWalletOverview(address: string, opts?: { noCache?: boolean; archAddress?: string }): Promise<WalletOverviewResponse> {
    const params = new URLSearchParams();
    if (opts?.noCache) params.set("nocache", "");
    if (opts?.archAddress) params.set("archAddress", opts.archAddress);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return await this.requestJson(`/wallet/${encodeURIComponent(address)}/overview${qs}`);
  }

  async getArchAccount(address: string): Promise<unknown> {
    return await this.requestJson(`/wallet/${encodeURIComponent(address)}/arch-account`);
  }

  // ── Arch Transactions ──

  async getTransactionHistory(address: string, params?: TransactionListParams): Promise<TransactionListResponse> {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.page !== undefined) qs.set("page", String(params.page));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return await this.requestJson(`/wallet/${encodeURIComponent(address)}/transactions${suffix}`);
  }

  async getTransactionDetail(txid: string): Promise<ArchTransactionDetail> {
    return await this.requestJson(`/wallet/transactions/${encodeURIComponent(txid)}`);
  }

  // ── Tokens ──

  async getTokenList(params?: { q?: string; sort?: string; limit?: number }): Promise<TokenListResponse> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return await this.requestJson(`/wallet/tokens${suffix}`);
  }

  async getTokenDetail(mint: string): Promise<TokenInfo> {
    return await this.requestJson(`/wallet/tokens/${encodeURIComponent(mint)}`);
  }

  // ── Network ──

  async getNetworkStats(): Promise<NetworkStatsResponse> {
    return await this.requestJson("/wallet/network/stats");
  }

  // ── Faucet ──

  async requestFaucetAirdrop(address: string): Promise<FaucetAirdropResponse> {
    return await this.requestJson("/wallet/faucet/airdrop", {
      method: "POST",
      body: JSON.stringify({ address })
    });
  }

  // ── Token Holdings ──

  async getTokensHeld(address: string): Promise<unknown> {
    return await this.requestJson(`/wallet/${encodeURIComponent(address)}/tokens-held`);
  }

  // ── Bitcoin ──

  async getBtcAddressSummary(address: string): Promise<BtcAddressSummary> {
    return await this.requestJson(`/wallet/btc/address/${encodeURIComponent(address)}`);
  }

  async getBtcUtxos(address: string): Promise<BtcUtxo[]> {
    return await this.requestJson(`/wallet/btc/address/${encodeURIComponent(address)}/utxos`);
  }

  async getBtcTransactions(address: string, afterTxid?: string): Promise<BtcTransaction[]> {
    const suffix = afterTxid ? `?after_txid=${encodeURIComponent(afterTxid)}` : "";
    return await this.requestJson(`/wallet/btc/address/${encodeURIComponent(address)}/txs${suffix}`);
  }

  async getBtcTransaction(txid: string): Promise<BtcTransaction> {
    return await this.requestJson(`/wallet/btc/tx/${encodeURIComponent(txid)}`);
  }

  async getBtcFeeEstimates(): Promise<BtcFeeEstimates> {
    return await this.requestJson("/wallet/btc/fee-estimates");
  }

  async sendBitcoin(params: SendBtcRequest): Promise<SendBtcResponse> {
    return await this.requestJson("/btc/send", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  async prepareBtcSend(params: PrepareBtcSendRequest): Promise<PrepareBtcSendResponse> {
    return await this.requestJson("/btc/prepare-send", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  async finalizeBtcTransaction(params: FinalizeBtcRequest): Promise<FinalizeBtcResponse> {
    return await this.requestJson("/btc/finalize-and-broadcast", {
      method: "POST",
      body: JSON.stringify(params)
    });
  }

  // ── Account Token Holdings ──

  async getAccountTokens(address: string): Promise<AccountTokensResponse> {
    return await this.requestJson(`/wallet/${encodeURIComponent(address)}/tokens-held`);
  }
}
