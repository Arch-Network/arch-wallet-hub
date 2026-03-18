export type WalletHubClientOptions = {
  baseUrl: string; // e.g. https://wallet-hub.arch.network/v1
  apiKey?: string; // optional when nginx injects it server-side
  fetchImpl?: typeof fetch;
};

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

export type PortfolioResponse = {
  inputAddress: string;
  resolvedArchAccountAddress: string;
  btc: { address: string; summary: unknown | null; utxos: unknown | null };
  arch: { accountAddress: string; summary: unknown | null; transactions: unknown | null };
};

export type TurnkeyConfigResponse = {
  organizationId: string;
  apiBaseUrl: string;
};

export type CreateTurnkeyWalletRequest = {
  externalUserId: string;
  walletName?: string;
  addressFormat?: string;
  derivationPath?: string;
};

export type CreateTurnkeyPasskeyWalletRequest = CreateTurnkeyWalletRequest & {
  passkey: {
    challenge: string; // base64url
    attestation: unknown;
  };
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
};

export type ListTurnkeyWalletsResponse = {
  externalUserId: string;
  userId: string | null;
  wallets: GetTurnkeyWalletResponse[];
};

export type AirdropArchAccountRequest = {
  archAccountAddress: string;
  lamports?: string;
};

export type AirdropArchAccountResponse = {
  archAccountAddress: string;
  result: unknown;
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

export type CreateSigningRequest = {
  externalUserId: string;
  signer:
    | { kind: "external"; taprootAddress: string; publicKeyHex?: string }
    | { kind: "turnkey"; resourceId: string };
  action:
    | { type: "arch.transfer"; toAddress: string; lamports: string }
    | { type: "arch.token_transfer"; mintAddress: string; toAddress: string; amount: string; decimals?: number }
    | { type: "arch.anchor"; btcTxid: string; vout: number };
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

// ── Wallet Overview ──

export type WalletOverviewResponse = {
  inputAddress: string;
  archAccountAddress: string;
  btcAddress: string;
  arch: {
    account: {
      address: string;
      address_hex: string;
      balance: string;
      first_seen_at: string;
      last_seen_at: string;
    } | null;
    recentTransactions: {
      transactions: ArchTransaction[];
    } | null;
  };
  btc: {
    summary: BtcAddressSummary | null;
  };
};

export type ArchTransaction = {
  txid: string;
  block_height: number;
  created_at: string;
  confirmed_at?: string;
  status: Record<string, unknown>;
  instructions?: string[];
  fee_estimated_arch?: number;
  from_address?: string;
  to_address?: string;
  programs?: string[];
  token_mints?: string[];
  token_transfer?: {
    program_id?: string;
    source_account?: string;
    destination_account?: string;
    mint?: string;
    amount?: string;
    decimals?: number;
    authority?: string;
  } | null;
};

export type ArchTransactionDetail = ArchTransaction & {
  data?: Record<string, unknown>;
  bitcoin_txids?: string[];
  logs?: string[];
};

export type BtcAddressSummary = {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
  };
};

export type BtcUtxo = {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
};

export type BtcTransaction = {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
  vin: unknown[];
  vout: unknown[];
};

// ── Transactions List ──

export type TransactionListResponse = {
  total_count: number | null;
  next_cursor: string | null;
  page: number | null;
  limit: number | null;
  transactions: ArchTransaction[];
};

export type TransactionListParams = {
  limit?: number;
  page?: number;
  cursor?: string;
  offset?: number;
};

// ── Tokens ──

export type TokenInfo = {
  mint_address: string;
  mint_address_hex: string;
  program_id: string;
  decimals: number;
  supply: string;
  name: string;
  symbol: string;
  image: string;
  description: string;
};

export type TokenListResponse = {
  page: number;
  limit: number;
  total: number;
  results: TokenInfo[];
};

// ── Network ──

export type NetworkStatsResponse = {
  total_transactions: number;
  total_blocks: number;
  indexed_height: number;
  latest_block_height: number;
  current_tps: number;
  average_tps: number;
  peak_tps: number;
  daily_transactions: number;
};

// ── Faucet ──

export type FaucetAirdropResponse = {
  txid: string;
  address: string;
  network: string;
};

// ── BTC Send ──

export type SendBtcRequest = {
  externalUserId: string;
  turnkeyResourceId: string;
  toAddress: string;
  amountSats: number;
  feeRate?: number;
};

export type SendBtcResponse = {
  txid: string;
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  feeSats: number;
  feeRate: number;
};

// ── BTC Prepare Send (unsigned PSBT) ──

export type PrepareBtcSendRequest = {
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  feeRate?: number;
};

export type PrepareBtcSendResponse = {
  psbtBase64: string;
  psbtHex: string;
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  feeSats: number;
  feeRate: number;
  changeSats: number;
  inputCount: number;
};

// ── BTC Finalize + Broadcast ──

export type FinalizeBtcRequest = {
  signedPsbtBase64: string;
  network?: "testnet" | "mainnet";
};

export type FinalizeBtcResponse = {
  txid: string;
  rawTxHex: string;
};

// ── BTC Fee Estimates ──

export type BtcFeeEstimates = Record<string, number>;

// ── Account Token Holdings ──

export type AccountTokenBalance = {
  mint_address: string;
  mint_address_hex: string;
  token_account_address: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  image: string | null;
  amount: string;
  ui_amount: string;
  state: "uninitialized" | "initialized" | "frozen";
};

export type AccountTokensResponse = {
  owner: string;
  tokens: AccountTokenBalance[];
};
