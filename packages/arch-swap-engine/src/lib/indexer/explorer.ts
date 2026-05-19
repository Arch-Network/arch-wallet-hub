// Explorer-facing read helpers backed by the indexer REST endpoints.
//
// All requests go through `indexerFetch` from `@/indexer/client` —
// the same transport every other indexer-backed module uses.

import { indexerFetch } from "@/lib/indexer/client";
import type { TokenBalanceEntry } from "@/lib/indexer/balances";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Block = {
  height: number;
  hash: string;
  timestamp: string;
  bitcoin_block_height: number | null;
  transaction_count: number;
  previous_block_hash: string | null;
  block_size_bytes: number | null;
};

export type BlocksResponse = {
  total_count: number;
  blocks: Block[];
};

export type BlockWithTransactions = Block & {
  transactions: Transaction[] | null;
};

export type Transaction = {
  txid: string;
  block_height: number;
  data: unknown;
  status: unknown;
  bitcoin_txids: string[] | null;
  created_at: string;
  logs?: string[];
};

export type TransactionsResponse = {
  total_count: number | null;
  transactions: Transaction[];
};

export type ExecutionResponse = {
  status: unknown;
  logs: string[];
  bitcoin_txid: string | null;
  rollback_status: unknown;
  compute_units_consumed: number | null;
  runtime_transaction: unknown;
  has_cpi: boolean;
  cpi_count: number | null;
};

export type InstructionTreeNode = {
  index: number | null;
  inner_index: number | null;
  depth: number;
  program_id_base58: string;
  program_id_hex: string;
  action: string | null;
  decoded: Record<string, unknown> | null;
  accounts: string[];
  children: InstructionTreeNode[];
};

export type Participant = {
  address_hex: string;
  address_base58: string;
  is_signer: boolean;
  is_writable: boolean;
  is_readonly: boolean;
  is_fee_payer: boolean;
};

export type InstructionRow = {
  index: number;
  program_id_hex: string;
  program_id_base58: string;
  program_name: string | null;
  accounts: string[];
  data_len: number;
  action: string | null;
  decoded: Record<string, unknown> | null;
  data_hex: string;
};

export type AccountResponse = {
  address: string;
  address_hex: string;
  first_seen: string | null;
  last_seen: string | null;
  transaction_count: number;
  lamports_balance?: number | null;
};

export type AccountTransactionV2 = {
  txid: string;
  block_height?: number;
  created_at?: string;
  status?: unknown;
  instructions?: string[];
  programs?: string[];
};

export type AccountTransactionsV2Response = {
  page: number;
  limit: number;
  transactions: AccountTransactionV2[];
};

export type NetworkStats = {
  total_transactions: number;
  total_blocks: number;
  indexed_height: number;
  indexed_blocks: number;
  network_total_blocks: number;
  latest_block_height: number;
  block_height: number;
  slot_height: number;
  current_tps: number;
  average_tps: number;
  peak_tps: number;
  daily_transactions: number;
  missing_blocks: number;
  total_accounts: number;
  total_programs: number;
  active_programs_24h: number;
};

export type SearchResultItem = {
  txid?: string;
  height?: number;
  hash?: string;
  address?: string;
  address_hex?: string;
  program_id?: string;
  program_id_base58?: string;
  display_name?: string;
  mint?: string;
  mint_hex?: string;
  decimals?: number;
  symbol?: string | null;
  url: string;
};

export type SearchResponse = {
  query: string;
  bestGuess: {
    redirect: boolean;
    type?: string;
    url?: string;
    confidence?: number;
  };
  results: {
    transactions: SearchResultItem[] | null;
    blocks: SearchResultItem[] | null;
    accounts: SearchResultItem[] | null;
    programs: SearchResultItem[] | null;
    tokens: SearchResultItem[] | null;
  };
};

export type Program = {
  program_id_hex: string;
  program_id_base58: string;
  transaction_count: number;
  first_seen_at: string;
  last_seen_at: string;
  display_name: string | null;
};

export type ProgramsResponse = {
  total_count: number;
  programs: Program[];
  page: number;
  limit: number;
};

export type AccountTokenBalancesResponse = {
  balances: TokenBalanceEntry[];
  total: number;
  page: number;
  limit: number;
};

export type TokenInfo = {
  mint_address: string;
  program_id: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  image: string | null;
  description: string | null;
  holders: number;
  supply: string | null;
  decimals: number | null;
};

export type TokensResponse = {
  total_count: number;
  tokens: TokenInfo[];
  page: number;
  limit: number;
};

// Re-exported for explorer consumers that imported it from this module's
// legacy location. `TokenBalanceEntry` itself lives with the balance helpers.
export type { TokenBalanceEntry };

// ---------------------------------------------------------------------------
// Fetch functions
// ---------------------------------------------------------------------------

export function fetchBlocks(limit = 10, offset = 0): Promise<BlocksResponse> {
  return indexerFetch(`/blocks?limit=${limit}&offset=${offset}`);
}

export function fetchBlockByHeight(height: number): Promise<Block> {
  return indexerFetch(`/blocks/height/${height}`);
}

export function fetchBlockByHash(hash: string): Promise<BlockWithTransactions> {
  return indexerFetch(`/blocks/${encodeURIComponent(hash)}`);
}

export function fetchTransactions(limit = 10, offset = 0): Promise<TransactionsResponse> {
  return indexerFetch(`/transactions?limit=${limit}&offset=${offset}&include_total=true`);
}

export function fetchTransaction(txid: string): Promise<Transaction> {
  return indexerFetch(`/transactions/${encodeURIComponent(txid)}`);
}

export function fetchTransactionExecution(txid: string): Promise<ExecutionResponse> {
  return indexerFetch(`/transactions/${encodeURIComponent(txid)}/execution`);
}

export function fetchTransactionTree(txid: string): Promise<InstructionTreeNode[]> {
  return indexerFetch(`/transactions/${encodeURIComponent(txid)}/tree`);
}

export function fetchTransactionParticipants(txid: string): Promise<Participant[]> {
  return indexerFetch(`/transactions/${encodeURIComponent(txid)}/participants`);
}

export function fetchTransactionInstructions(txid: string): Promise<InstructionRow[]> {
  return indexerFetch(`/transactions/${encodeURIComponent(txid)}/instructions`);
}

export function fetchAccount(address: string): Promise<AccountResponse> {
  return indexerFetch(`/accounts/${encodeURIComponent(address)}`);
}

export function fetchAccountTransactions(
  address: string,
  limit = 20,
  page = 1,
): Promise<AccountTransactionsV2Response> {
  return indexerFetch(
    `/accounts/${encodeURIComponent(address)}/transactions/v2?limit=${limit}&page=${page}`,
  );
}

export function fetchNetworkStats(): Promise<NetworkStats> {
  return indexerFetch("/network/stats");
}

export function fetchSearch(query: string): Promise<SearchResponse> {
  return indexerFetch(`/search?q=${encodeURIComponent(query)}`);
}

export function fetchPrograms(limit = 20, offset = 0): Promise<ProgramsResponse> {
  return indexerFetch(`/programs?limit=${limit}&offset=${offset}`);
}

export function fetchTokens(limit = 20, offset = 0): Promise<TokensResponse> {
  return indexerFetch(`/tokens?limit=${limit}&offset=${offset}`);
}

export function fetchAccountTokenBalancesPaged(
  address: string,
  limit = 25,
  page = 1,
): Promise<AccountTokenBalancesResponse> {
  return indexerFetch(
    `/accounts/${encodeURIComponent(address)}/token-balances?limit=${limit}&page=${page}`,
  );
}
