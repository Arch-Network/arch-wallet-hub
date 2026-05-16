/**
 * Lightweight classifier for Arch transactions that derives a short,
 * human-readable label from the `/transactions/v2` response. Designed for
 * activity feeds where we don't want to call `/instructions` per tx but
 * still want to show something better than the txid.
 *
 * v2 rows include:
 *   instructions:  string[]      e.g. ["System: Transfer", "Token: Transfer"]
 *   programs:      string[]      program names invoked
 *   status:        object|string
 *   fee_payer:     string
 *   token_transfer?: { source_account, destination_account, amount, decimals, mint }
 *
 * This module deliberately ignores anything it can't classify reliably and
 * falls back to "Arch Transaction" so the dashboard never shows a blank row.
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

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
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

/**
 * Derive a one-line summary from a v2 transaction row.
 *
 * The function is intentionally forgiving: missing fields fall back to
 * "Arch Transaction" rather than throwing or returning null. Callers can
 * assume they always have a label suitable for display.
 */
export function summarizeArchTx(tx: any, archAddress: string): ArchTxSummary {
  const failed = isFailedStatus(tx?.status);
  const labels = asArray<string>(tx?.instructions).filter((s) => typeof s === "string");

  // Token transfer takes priority when the row carries decoded data, even
  // for failed txs -- we still want to know "Sent Token (failed)" rather
  // than just "Failed Transaction" with no context.
  const tokenSummary = summarizeTokenTransfer(tx, archAddress);
  if (tokenSummary) {
    return { kind: "token_transfer", ...tokenSummary };
  }

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
