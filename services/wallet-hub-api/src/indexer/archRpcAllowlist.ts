/**
 * Read-only allowlist for `POST /v1/indexer/arch/rpc` (issue #45).
 *
 * The Hub holds a privileged Indexer key. Without an allowlist, any
 * authenticated app could forward arbitrary JSON-RPC methods (including
 * mutating ones like `send_transaction` / `request_airdrop`) through
 * that key. Only methods the wallet actually needs for reads belong
 * here; anything else is rejected with 403 before we hit upstream.
 *
 * Sourced from chrome-wallet Hub call sites today:
 *   - `read_account_info` — APL / account metadata (`arch-rpc.ts`, ANS)
 *   - `get_slot` / `get_block_count` — ANS slot fallback
 *   - `get_best_block_hash` — ANS transport
 *
 * `get_program_accounts` is read-only and used by arch-swap-engine
 * against the indexer directly today; allowing it on the Hub proxy
 * keeps a single read surface if that traffic moves Hub-side later.
 *
 * Explicitly NOT allowed: `send_transaction`, `request_airdrop`, and
 * any other write / faucet path (those have dedicated audited routes).
 */
export const ALLOWED_ARCH_RPC_METHODS = [
  "read_account_info",
  "get_slot",
  "get_block_count",
  "get_best_block_hash",
  "get_program_accounts",
] as const;

export type AllowedArchRpcMethod = (typeof ALLOWED_ARCH_RPC_METHODS)[number];

const ALLOWED = new Set<string>(ALLOWED_ARCH_RPC_METHODS);

export function isAllowedArchRpcMethod(method: string): method is AllowedArchRpcMethod {
  return ALLOWED.has(method);
}
