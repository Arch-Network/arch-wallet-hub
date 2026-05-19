// Indexer-backed account data reads via `read_account_info` and
// `get_program_accounts`.

import { indexerRpc } from "@/lib/indexer/client";

/**
 * Validator-shaped account info. `data` and `owner` are u8 arrays;
 * `utxo` is the Bitcoin anchor hex (or `""` for unanchored accounts).
 */
export type AccountInfo = {
  data: number[];
  owner: number[];
  lamports: number;
  utxo: string;
  is_executable: boolean;
  tag: number[];
};

/**
 * Filter variants for `get_program_accounts`. Either constrain by
 * `data` byte length or by a substring of the account's `data` bytes
 * at a specific offset.
 */
export type ProgramAccountFilter =
  | { DataSize: number }
  | { DataContent: { offset: number; bytes: number[] } };

/**
 * Single result entry from `get_program_accounts` — a discovered
 * account's pubkey plus its full `AccountInfo`.
 */
export type ProgramAccountEntry = {
  pubkey: number[];
  account: AccountInfo;
};

// The indexer's pubkey parser accepts u8 arrays, hex strings, or base58.
// Pass through whichever form the caller has.
function pubkeyToParam(pubkey: Uint8Array | string): unknown {
  return typeof pubkey === "string" ? pubkey : Array.from(pubkey);
}

/**
 * Read an account's full info. Returns `null` when the indexer has no
 * row for this pubkey — treat as "not indexed yet," not "absent."
 *
 * Accepts a `Uint8Array` (32 bytes) or a 64-char hex string.
 */
export async function fetchAccountInfo(
  pubkey: Uint8Array | string,
): Promise<AccountInfo | null> {
  return indexerRpc<AccountInfo | null>("read_account_info", [
    pubkeyToParam(pubkey),
  ]);
}

/**
 * Return just the account's `data` as a `Uint8Array`. Throws when the
 * account isn't indexed — use this where a missing account is a hard
 * error (e.g. pool state deserialization). For sparse-data call sites
 * (e.g. uninitialized tick arrays) use `fetchAccountInfo` and handle null.
 */
export async function fetchAccountData(
  pubkey: Uint8Array | string,
): Promise<Uint8Array> {
  const info = await fetchAccountInfo(pubkey);
  if (!info) {
    const id =
      typeof pubkey === "string"
        ? pubkey
        : Array.from(pubkey)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    throw new Error(`Account ${id} not indexed`);
  }
  return new Uint8Array(info.data);
}

/**
 * Query all accounts owned by `programId`, optionally constrained by
 * `DataSize` / `DataContent` filters. The indexer serves this from its
 * Postgres copy of the accounts table.
 *
 * Filters compose with AND semantics. The result preserves the
 * indexer's pubkey ordering.
 */
export async function fetchProgramAccounts(
  programId: Uint8Array | string,
  filters: readonly ProgramAccountFilter[] = [],
): Promise<ProgramAccountEntry[]> {
  return indexerRpc<ProgramAccountEntry[]>("get_program_accounts", [
    pubkeyToParam(programId),
    filters,
  ]);
}
