// ── Shared Arch Network types ──────────────────────────────────────────────

export type { TokenSymbol } from "@/lib/network/config";
import type { TokenSymbol } from "@/lib/network/config";

export type QuoteSide = "sell" | "buy";

export type RuntimeMessage = {
  header: {
    num_required_signatures: number;
    num_readonly_signed_accounts: number;
    num_readonly_unsigned_accounts: number;
  };
  account_keys: number[][];
  recent_blockhash: number[];
  instructions: Array<{
    program_id_index: number;
    accounts: number[];
    data: number[];
  }>;
};

export type RuntimeTransaction = {
  version?: number;
  signatures: number[][];
  message: RuntimeMessage;
};

export type CreateAccountResponse =
  | { status: "already_exists"; message?: string }
  | { status: "created"; message?: string }
  | {
      status: "needs_signature";
      message?: string;
      transaction: RuntimeTransaction;
    };

export type CreateAtaResponse =
  | { status: "all_exist" }
  | { status: "needs_signature"; transaction: RuntimeTransaction };

export type QuoteResponse = RuntimeTransaction;

export type FaucetResponse = {
  minted: number | string;
  token: TokenSymbol | string;
};

export type PriceResponse = {
  price: number;
};

/**
 * Per-token balances, in the token's native decimal units. Only the symbols
 * configured on the active network's `tradingPair`/`tokens` are populated —
 * e.g. on testnet you'll get `{ BTC, USDC }` and on mainnet `{ BTC, USDT }`,
 * never all three at once. Callers should access defensively
 * (`balances[symbol] ?? 0`) instead of assuming a key exists.
 */
export type BalancesResponse = Partial<Record<TokenSymbol, number>>;

export type ArchRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: "send_transaction" | "get_processed_transaction";
  params: RuntimeTransaction | string;
};

export type ArchRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code?: number; message?: string; data?: unknown } | unknown;
};

export type ProcessedTransaction = {
  runtime_transaction: RuntimeTransaction;
  status: { type: "processing" | "processed" } | { type: "failed"; message: string };
  bitcoin_txid: number[] | null;
  logs: string[];
  rollback_status: { type: "notRolledback" } | { type: "rolledback"; message: string };
  inner_instructions_list?: unknown;
};

// ── AMM type toggle ────────────────────────────────────────────────────────

export type AmmType = "propamm" | "clamm";

export type AmmMode = "propamm" | "clamm" | "aggregator";
