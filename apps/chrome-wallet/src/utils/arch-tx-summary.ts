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

const TRANSFER_LABELS = new Set([
  "System: Transfer",
  "Token: Transfer",
  "Token: TransferChecked",
]);
const MINT_LABELS = new Set(["Token: MintTo", "Token: MintToChecked"]);
const BURN_LABELS = new Set(["Token: Burn", "Token: BurnChecked"]);
const ATA_LABELS = new Set([
  "Associated Token Account: Create",
  "AssociatedTokenAccount: Create",
]);
const CREATE_ACCOUNT_LABELS = new Set([
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
  const labels = asArray<string>(tx?.instructions).filter((s) => typeof s === "string");

  // Token transfer takes priority when the row carries decoded data.
  const tokenSummary = summarizeTokenTransfer(tx, archAddress);
  if (tokenSummary) {
    return { kind: "token_transfer", ...tokenSummary };
  }

  // Otherwise consult the chip labels.
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

  // Fall back to the first sane label or a generic name.
  const firstLabel = labels.find((l) => l && !l.startsWith("Compute Budget"));
  if (firstLabel) {
    return { kind: "other", label: firstLabel, direction: "unknown" };
  }
  return { kind: "other", label: "Arch Transaction", direction: "unknown" };
}
