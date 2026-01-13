export type WalletHubClientOptions = {
  baseUrl: string; // e.g. https://wallet-hub.arch.network/v1
  apiKey: string;
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

export type CreateSigningRequest = {
  externalUserId: string;
  signer:
    | { kind: "external"; taprootAddress: string }
    | { kind: "turnkey"; resourceId: string };
  action:
    | { type: "arch.transfer"; toAddress: string; lamports: string }
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
  signedTransaction: string;
};

export type SubmitSigningResponse = {
  signingRequestId: string;
  status: string;
  result: unknown;
};
