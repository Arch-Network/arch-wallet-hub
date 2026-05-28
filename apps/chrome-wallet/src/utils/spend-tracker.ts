/**
 * Per-origin rolling-24h spend tracker.
 *
 * Used by the Permission Center to enforce
 * `SitePermissions.spendingLimitSatsPerDay`: every successful
 * approve-and-broadcast on behalf of a connected dapp appends a
 * `(origin, asset, network, amount, ts)` record. The Approve gate
 * sums records from the last 24 hours, adds the pending request's
 * amount, and refuses when the sum exceeds the cap.
 *
 * Storage: `chrome.storage.local` under `arch_wallet_spend_log`.
 * One flat array (no per-origin sharding) because the upper bound is
 * tiny -- a user with 10 dapps signing 10 times/day each is still
 * 100 entries/day, pruned daily; we ship a 256-entry hard cap that
 * the prune step enforces.
 *
 * What we DON'T persist:
 *   - Recipient addresses (privacy: tracker is a quota counter, not
 *     a history surface; History lives in the indexer-backed
 *     activity view).
 *   - txids. Not needed for cap arithmetic and adding them would
 *     re-expose the tracker as a leakable wallet history.
 *
 * Failure modes:
 *   - Storage read/write failures swallow silently. The cap then
 *     fails OPEN (no enforcement) rather than FAIL CLOSED (block
 *     every dapp transfer); the latter would let a single corrupted
 *     storage blob nuke the wallet's ability to transact.
 */

const STORAGE_KEY = "arch_wallet_spend_log";
const MAX_ENTRIES = 256;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export type SpendAsset = "arch" | "btc";

export interface SpendRecord {
  origin: string;
  asset: SpendAsset;
  /** Mainnet vs testnet are separately gated; never sum across them. */
  network: string;
  /**
   * Amount in the asset's smallest unit: lamports for "arch",
   * satoshis for "btc". Stored as a string so we never lose
   * precision on amounts that overflow Number.MAX_SAFE_INTEGER
   * (BTC totals in sats fit, but ARCH lamports can exceed it).
   */
  amount: string;
  /** Unix-ms timestamp the wallet recorded the spend. */
  ts: number;
}

interface ChromeStorageAreaLike {
  get: (
    keys: string | string[] | null,
  ) => Promise<Record<string, unknown>> | void;
  set: (
    items: Record<string, unknown>,
  ) => Promise<void> | void;
}

function getStorageLocal(): ChromeStorageAreaLike | null {
  return (globalThis as any).chrome?.storage?.local ?? null;
}

async function readLog(): Promise<SpendRecord[]> {
  const storage = getStorageLocal();
  if (!storage) return [];
  try {
    const res = (await storage.get(STORAGE_KEY)) as Record<string, unknown>;
    const raw = res?.[STORAGE_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isSpendRecord);
  } catch {
    return [];
  }
}

async function writeLog(records: SpendRecord[]): Promise<void> {
  const storage = getStorageLocal();
  if (!storage) return;
  try {
    await storage.set({ [STORAGE_KEY]: records });
  } catch {
    /* swallow -- enforcement fails open if storage refuses */
  }
}

function isSpendRecord(x: unknown): x is SpendRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.origin === "string" &&
    (r.asset === "arch" || r.asset === "btc") &&
    typeof r.network === "string" &&
    typeof r.amount === "string" &&
    typeof r.ts === "number"
  );
}

/**
 * Drop entries older than the rolling window AND truncate to
 * MAX_ENTRIES (newest first). Both bounds are needed: the window
 * keeps short-term math correct, the cap keeps storage bounded in
 * adversarial cases (e.g. a dapp loop signing tiny transfers).
 */
function prune(records: SpendRecord[], now: number): SpendRecord[] {
  const cutoff = now - WINDOW_MS;
  const fresh = records.filter((r) => r.ts >= cutoff);
  if (fresh.length <= MAX_ENTRIES) return fresh;
  return [...fresh].sort((a, b) => b.ts - a.ts).slice(0, MAX_ENTRIES);
}

/**
 * Append a spend to the log. Called from the success branches in
 * Approve.tsx and Send.tsx after the broadcast resolves. Pruning
 * runs on every write so the log never grows unboundedly.
 */
export async function recordSpend(opts: {
  origin: string;
  asset: SpendAsset;
  network: string;
  amount: string | number | bigint;
  now?: number;
}): Promise<void> {
  if (!opts.origin) return;
  const ts = opts.now ?? Date.now();
  const amount = typeof opts.amount === "string" ? opts.amount : opts.amount.toString();
  const record: SpendRecord = {
    origin: opts.origin,
    asset: opts.asset,
    network: opts.network,
    amount,
    ts,
  };
  const existing = await readLog();
  const next = prune([...existing, record], ts);
  await writeLog(next);
}

/**
 * Sum recent spend for an `(origin, asset, network)` triple within
 * the rolling window. Returns the total as a bigint so callers can
 * compare against caps (also bigint or number) without precision
 * loss. Falls back to `0n` on any read or parse failure -- callers
 * MUST treat that as "no enforcement", not "zero spent so far".
 */
export async function getRecentSpend(opts: {
  origin: string;
  asset: SpendAsset;
  network: string;
  now?: number;
}): Promise<bigint> {
  const now = opts.now ?? Date.now();
  const cutoff = now - WINDOW_MS;
  const records = await readLog();
  let total = 0n;
  for (const r of records) {
    if (r.origin !== opts.origin) continue;
    if (r.asset !== opts.asset) continue;
    if (r.network !== opts.network) continue;
    if (r.ts < cutoff) continue;
    try {
      total += BigInt(r.amount);
    } catch {
      /* malformed -- skip silently rather than failing the whole sum */
    }
  }
  return total;
}

/**
 * Decide whether a pending spend exceeds the cap, given the cap +
 * recent total in the same units. Pure: useful for unit tests and
 * for callers that already have the recent total in hand.
 *
 *   - `cap === undefined` → no enforcement (Permission Center never
 *     wrote one for this origin).
 *   - `cap === 0n`        → block everything (the user explicitly
 *     zeroed the cap; we honor it as a kill switch rather than
 *     re-interpreting zero as "disabled").
 */
export function exceedsCap(opts: {
  pending: bigint;
  recent: bigint;
  cap: bigint | undefined;
}): boolean {
  if (opts.cap === undefined) return false;
  return opts.recent + opts.pending > opts.cap;
}

/** Test-only: wipe the log. */
export async function __resetSpendLogForTests(): Promise<void> {
  await writeLog([]);
}
