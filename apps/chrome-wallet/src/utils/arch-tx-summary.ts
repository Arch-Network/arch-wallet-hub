/**
 * Classifier for Arch transactions that derives a short, human-readable
 * label, direction, and amount from indexer data.
 *
 * v2 rows alone (`/accounts/:addr/transactions/v2`) carry:
 *   instructions:  string[]      e.g. ["System: Transfer", "Token: Transfer"]
 *   programs:      string[]      program names invoked
 *   status:        object|string
 *   fee_payer:     string
 *   token_transfer?: { source_account, destination_account, amount, decimals, mint }
 *
 * After being merged with `/transactions/:txid` detail, `instructions` becomes
 * an array of decoded objects with shape:
 *   { action: "System: Transfer", decoded: { source, destination, amount/lamports } }
 * We use the decoded form when present to get direction + amount for plain
 * ARCH transfers (which v2 doesn't summarise the way it does token_transfer).
 *
 * This module deliberately ignores anything it can't classify reliably and
 * falls back to a generic label so the dashboard never shows a blank row.
 */

export type ArchTxKind =
  | "btc_send"
  | "token_transfer"
  | "system_transfer"
  | "create_account"
  | "ata_create"
  | "swap"
  | "mint"
  | "burn"
  | "compute_budget"
  | "other";

// The indexer's v2 endpoint emits both the prefixed and bare forms ("Transfer"
// vs "System: Transfer"), so we match against either. Comparisons are done
// against the lowercase tail of the colon, so callers can throw any case at us.
const TRANSFER_LABELS = new Set([
  "Transfer",
  "TransferChecked",
  "System: Transfer",
  "Token: Transfer",
  "Token: TransferChecked",
]);
const MINT_LABELS = new Set(["MintTo", "MintToChecked", "Token: MintTo", "Token: MintToChecked"]);
const BURN_LABELS = new Set(["Burn", "BurnChecked", "Token: Burn", "Token: BurnChecked"]);
const ATA_LABELS = new Set([
  "Create",
  "Associated Token Account: Create",
  "AssociatedTokenAccount: Create",
]);
const CREATE_ACCOUNT_LABELS = new Set([
  "CreateAccount",
  "Create",
  "System: CreateAccount",
  "System: Create",
  "System: CreateAccountWithSeed",
]);

export interface ArchTxSummary {
  kind: ArchTxKind;
  /** Short label like "Token Transfer", "Sent ARCH", "Received APL", "Mint". */
  label: string;
  direction: "in" | "out" | "neutral" | "unknown";
  /** Pre-signed token amount, e.g. "+1024" or "-0.001"; undefined when unknown. */
  amountLabel?: string;
  /** Counterparty address (best-effort) when we can identify one. */
  counterparty?: string;
}

import bs58 from "bs58";

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Compute all address forms (base58 + 64-char hex) a given account
 * might appear under across the indexer's endpoints. The v2 row uses
 * base58; the `/tree` endpoint returns hex. Without normalizing,
 * CPI'd token transfers silently fail to match the user's account
 * (same root cause as the BTC-balance mismatch fixed earlier).
 */
export function addressForms(addr: string): Set<string> {
  const out = new Set<string>();
  if (!addr) return out;
  out.add(addr);
  if (/^[0-9a-fA-F]{64}$/.test(addr)) {
    try {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i += 1) {
        bytes[i] = parseInt(addr.slice(i * 2, i * 2 + 2), 16);
      }
      out.add(bs58.encode(bytes));
    } catch { /* ignore */ }
  } else {
    try {
      const bytes = bs58.decode(addr);
      if (bytes.length === 32) {
        const hex = Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        out.add(hex);
      }
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * Heuristics for filtering garbage labels. The indexer's /transactions/v2
 * endpoint reuses the `instructions` field as a chip-display field, and for
 * failed transactions it can dump the raw failure JSON in there as a single
 * string (e.g. '{"FAILED":"Error processing Instruction 0..."}'). Those
 * strings should never be shown to a user as if they were an action label.
 */
function isUsableLabel(label: string): boolean {
  if (!label) return false;
  if (label.length > 60) return false; // sanity cap -- real labels are short
  const trimmed = label.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (/^\s*(FAILED|Failed|failed|ERROR|Error|error)\b/.test(trimmed)) return false;
  if (/error processing instruction/i.test(trimmed)) return false;
  return true;
}

/**
 * Try to detect a failed status across the various shapes the indexer can
 * emit:
 *   "failed" / "FAILED"               (v2 normalized string, any case)
 *   '{"FAILED":"..."}'                (raw JSON string the indexer sometimes
 *                                      embeds without parsing)
 *   { Failed: "..." }                 (legacy v1)
 *   { failed: true }
 */
function isFailedStatus(status: unknown): boolean {
  if (typeof status === "string") {
    if (/^(failed|rejected)$/i.test(status)) return true;
    // Raw JSON failure object that hasn't been parsed yet
    if (/^\s*\{[^}]*\b(FAILED|Failed|failed|REJECTED|Rejected|rejected)\b/.test(status)) return true;
  }
  if (status && typeof status === "object") {
    const keys = Object.keys(status as Record<string, unknown>);
    return keys.some((k) => /^(Failed|Rejected|failed|rejected)$/.test(k));
  }
  return false;
}

function formatRawAmountWithDecimals(raw: string, decimals: number): string {
  try {
    const n = BigInt(raw);
    if (decimals <= 0) return n.toString();
    const s = n.toString().padStart(decimals + 1, "0");
    const whole = s.slice(0, -decimals);
    const frac = s.slice(-decimals).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  } catch {
    return raw;
  }
}

const SYSTEM_TRANSFER_ACTIONS = new Set([
  "Transfer",
  "System: Transfer",
]);

const TOKEN_TRANSFER_ACTIONS = new Set([
  "Token: Transfer",
  "Token: TransferChecked",
]);

/**
 * Flatten an indexer instructions response across whatever nesting
 * convention the server uses (top-level array, `inner_instructions`,
 * `cpi`, `children`, or a flat list with `stack_height`). Annotates each
 * node with `__depth` so callers can distinguish CPI movements (swaps,
 * routed transfers, …) from direct top-level calls.
 */
function flattenInstructions(
  instructions: unknown,
): Array<Record<string, unknown> & { __depth: number }> {
  if (!Array.isArray(instructions)) return [];
  const out: Array<Record<string, unknown> & { __depth: number }> = [];
  const walk = (item: unknown, depth: number) => {
    if (!item || typeof item !== "object") return;
    const obj = item as Record<string, unknown>;
    out.push({ ...obj, __depth: depth });
    for (const key of ["inner_instructions", "innerInstructions", "cpi", "children"]) {
      const c = obj[key];
      if (Array.isArray(c)) {
        for (const sub of c) walk(sub, depth + 1);
      }
    }
  };
  for (const ix of instructions) walk(ix, 0);
  for (const node of out) {
    if (node.__depth === 0) {
      const sh = node.stack_height ?? node.stackHeight;
      if (typeof sh === "number" && sh > 1) node.__depth = sh - 1;
    }
  }
  return out;
}

/**
 * Look through decoded instruction objects (from `/transactions/:txid`)
 * for the first transfer-like instruction we can classify against the
 * caller's archAddress. Returns null when the input isn't decoded
 * instructions or no transfer was found.
 *
 * Walks both top-level instructions AND inner CPIs so AMM / router
 * swaps (where the Transfer happens via CPI from a custom program)
 * surface as "Swap" with the correct direction and amount instead of
 * a generic "Custom Instruction" row.
 */
function summarizeFromDecodedInstructions(
  instructions: unknown,
  archAddress: string,
  archAccountForms?: Set<string>,
  tokenAccountForms?: Set<string>,
): { kind: ArchTxKind; label: string; direction: "in" | "out" | "neutral"; amountLabel?: string; counterparty?: string } | null {
  const flat = flattenInstructions(instructions);
  if (flat.length === 0) return null;

  // Pre-compute hex+base58 forms of the user's archAddress so we can
  // match `decoded.authority` / source/destination regardless of which
  // form the indexer emits. The /tree endpoint uses hex; v2 row fields
  // use base58.
  const ownerForms = archAccountForms ?? addressForms(archAddress);
  // Token-account forms are optional but valuable: a swap CPI moves
  // funds into the user's ATA (NOT their archAddress), so without
  // knowing the ATAs we can't detect the incoming leg.
  const ataForms = tokenAccountForms ?? new Set<string>();

  for (const ix of flat) {
    const action = typeof ix.action === "string" ? ix.action : "";
    if (!action) continue;

    const decoded = (ix.decoded ?? {}) as Record<string, unknown>;
    const src = asString(decoded.source) || asString(decoded.from);
    const dst = asString(decoded.destination) || asString(decoded.to);
    const srcOwner = asString(decoded.source_owner) || asString(decoded.sourceOwner)
      || asString(decoded.authority) || asString(decoded.owner);
    const dstOwner = asString(decoded.destination_owner) || asString(decoded.destinationOwner);
    if (!src && !dst) continue;

    if (SYSTEM_TRANSFER_ACTIONS.has(action)) {
      const direction: "in" | "out" | "neutral" =
        ownerForms.has(src) ? "out" : ownerForms.has(dst) ? "in" : "neutral";
      if (direction === "neutral") continue;

      // System Transfer amounts come in lamports. Try `lamports` first,
      // fall back to `amount` for indexer versions that use either.
      const rawLamports = asString(decoded.lamports) || asString(decoded.amount);
      let amountLabel: string | undefined;
      if (rawLamports) {
        try {
          const lam = BigInt(rawLamports);
          // 9 decimal places like formatArch
          const archStr = formatRawAmountWithDecimals(lam.toString(), 9);
          const trimmed = trimTrailingZeros(archStr, 4);
          const sign = direction === "out" ? "-" : "+";
          amountLabel = `${sign}${trimmed} ARCH`;
        } catch {
          // Ignore malformed amounts -- still useful to show direction.
        }
      }

      return {
        kind: "system_transfer",
        label: direction === "in" ? "Received ARCH" : "Sent ARCH",
        direction,
        amountLabel,
        counterparty: direction === "in" ? src || undefined : dst || undefined,
      };
    }

    if (TOKEN_TRANSFER_ACTIONS.has(action)) {
      // Token transfers can fail-over to this path when the v2 row
      // didn't include token_transfer. Match against both the user's
      // ATAs (for CPI'd source/destination) AND their archAddress (for
      // authority/owner fields). The tree endpoint emits hex; v2 emits
      // base58 — the *Forms helpers handle both.
      const isOut =
        ataForms.has(src) ||
        ownerForms.has(srcOwner) ||
        ownerForms.has(src);
      const isIn =
        ataForms.has(dst) ||
        ownerForms.has(dstOwner) ||
        ownerForms.has(dst);
      const direction: "in" | "out" | "neutral" = isOut ? "out" : isIn ? "in" : "neutral";
      if (direction === "neutral") continue;

      const rawAmount = asString(decoded.amount);
      const decimals = typeof decoded.decimals === "number" ? decoded.decimals : 0;
      const pretty = rawAmount ? formatRawAmountWithDecimals(rawAmount, decimals) : null;
      const sign = direction === "out" ? "-" : "+";
      const amountLabel = pretty ? `${sign}${pretty}` : undefined;

      const viaCpi = ix.__depth > 0;
      const kind: ArchTxKind = viaCpi ? "swap" : "token_transfer";
      const label = viaCpi
        ? "Swap"
        : direction === "in" ? "Received Token" : "Sent Token";

      return {
        kind,
        label,
        direction,
        amountLabel,
        counterparty: direction === "in" ? src || undefined : dst || undefined,
      };
    }
  }
  return null;
}

/** Strip trailing zeros after the decimal point, keeping at least `keep` digits. */
function trimTrailingZeros(s: string, keep = 2): string {
  if (!s.includes(".")) return s;
  let [whole, frac] = s.split(".");
  if (frac.length <= keep) return s;
  frac = frac.replace(/0+$/, "");
  if (frac.length < keep) frac = frac.padEnd(keep, "0");
  return frac ? `${whole}.${frac}` : whole;
}

function summarizeTokenTransfer(
  tx: any,
  archAddress: string
): Pick<ArchTxSummary, "label" | "direction" | "amountLabel" | "counterparty"> | null {
  const tt = tx?.token_transfer;
  if (!tt || typeof tt !== "object") return null;

  const src = asString(tt.source_account);
  const dst = asString(tt.destination_account);
  const srcOwner = asString(tt.source_owner);
  const dstOwner = asString(tt.destination_owner);

  const isOut = src === archAddress || srcOwner === archAddress;
  const isIn = dst === archAddress || dstOwner === archAddress;
  const direction: ArchTxSummary["direction"] = isOut ? "out" : isIn ? "in" : "neutral";

  const rawAmount = asString(tt.amount) || String(tt.amount ?? "");
  const decimals = typeof tt.decimals === "number" ? tt.decimals : 0;
  const pretty = rawAmount ? formatRawAmountWithDecimals(rawAmount, decimals) : null;
  const sign = direction === "out" ? "-" : direction === "in" ? "+" : "";
  const amountLabel = pretty ? `${sign}${pretty}` : undefined;

  const counterparty = direction === "in" ? srcOwner || src || undefined : dstOwner || dst || undefined;

  let label = "Token Transfer";
  if (direction === "in") label = "Received Token";
  else if (direction === "out") label = "Sent Token";

  return { label, direction, amountLabel, counterparty };
}

export interface SummarizeOptions {
  /**
   * Optional /transactions/:txid/tree response. When provided, the
   * decoder walks this in addition to `tx.instructions` so it can see
   * Token: Transfer CPIs nested inside custom-program instructions
   * (the source-of-truth signal for AMM/router swaps).
   */
  tree?: unknown;
  /**
   * The user's known token accounts (ATA addresses) — needed to
   * classify the "incoming" leg of a CPI'd swap, where the destination
   * is the user's ATA rather than their archAddress.
   */
  tokenAccounts?: ReadonlyArray<string>;
}

/**
 * Derive a one-line summary from a v2 transaction row.
 *
 * The function is intentionally forgiving: missing fields fall back to
 * "Arch Transaction" rather than throwing or returning null. Callers can
 * assume they always have a label suitable for display.
 */
export function summarizeArchTx(
  tx: any,
  archAddress: string,
  options?: SummarizeOptions,
): ArchTxSummary {
  const failed = isFailedStatus(tx?.status);

  // Token transfer takes priority when the row carries decoded data, even
  // for failed txs -- we still want to know "Sent Token (failed)" rather
  // than just "Failed Transaction" with no context.
  const tokenSummary = summarizeTokenTransfer(tx, archAddress);
  if (tokenSummary) {
    return { kind: "token_transfer", ...tokenSummary };
  }

  const ownerForms = addressForms(archAddress);
  const ataForms = new Set<string>();
  for (const ata of options?.tokenAccounts ?? []) {
    for (const form of addressForms(ata)) ataForms.add(form);
  }

  // Prefer the tree (full CPI hierarchy with decoded children) over the
  // top-level-only `tx.instructions`. The tree is what lets us classify
  // CPI'd token movements correctly as "Swap" rather than the generic
  // "Custom Instruction" fallback.
  if (options?.tree) {
    const fromTree = summarizeFromDecodedInstructions(
      options.tree,
      archAddress,
      ownerForms,
      ataForms,
    );
    if (fromTree) return fromTree;
  }

  // After being merged with /transactions/:txid detail, `instructions`
  // becomes an array of decoded objects. When that's the case we can read
  // source/destination/amount directly for system + token transfers.
  const decodedSummary = summarizeFromDecodedInstructions(
    tx?.instructions,
    archAddress,
    ownerForms,
    ataForms,
  );
  if (decodedSummary) {
    return decodedSummary;
  }

  // Fall back to chip-label classification when only v2 strings are present.
  const labels = asArray<string>(tx?.instructions).filter((s) => typeof s === "string");

  // Consult the chip labels (best-effort match against both prefixed and
  // bare forms emitted by v2).
  let sawTransfer = false;
  let sawMint = false;
  let sawBurn = false;
  let sawAta = false;
  let sawCreate = false;
  for (const label of labels) {
    if (TRANSFER_LABELS.has(label)) sawTransfer = true;
    else if (MINT_LABELS.has(label)) sawMint = true;
    else if (BURN_LABELS.has(label)) sawBurn = true;
    else if (ATA_LABELS.has(label)) sawAta = true;
    else if (CREATE_ACCOUNT_LABELS.has(label)) sawCreate = true;
  }

  if (sawTransfer) {
    return { kind: "system_transfer", label: "Transfer", direction: "unknown" };
  }
  if (sawMint) {
    return { kind: "mint", label: "Token Mint", direction: "unknown" };
  }
  if (sawBurn) {
    return { kind: "burn", label: "Token Burn", direction: "unknown" };
  }
  if (sawAta) {
    return { kind: "ata_create", label: "Create Token Account", direction: "neutral" };
  }
  if (sawCreate) {
    return { kind: "create_account", label: "Create Account", direction: "neutral" };
  }

  // For failed txs we have no clean instruction labels to fall back on
  // (the indexer often stuffs the failure JSON into `instructions[0]`), so
  // skip the noisy fallback path entirely.
  if (failed) {
    return { kind: "other", label: "Failed Transaction", direction: "unknown" };
  }

  // Fall back to the first sane label or a generic name. isUsableLabel
  // rejects JSON-shaped failure dumps and overlong strings.
  const firstLabel = labels.find(
    (l) => l && !l.startsWith("Compute Budget") && isUsableLabel(l)
  );
  if (firstLabel) {
    return { kind: "other", label: firstLabel, direction: "unknown" };
  }
  return { kind: "other", label: "Arch Transaction", direction: "unknown" };
}
