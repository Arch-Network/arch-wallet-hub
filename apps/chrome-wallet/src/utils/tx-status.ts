export type TxStatus = "success" | "failed" | "pending" | "confirmed" | "unconfirmed";

export function normalizeArchStatus(tx: any): TxStatus {
  const status = tx?.status;
  if (typeof status === "string") {
    const lower = status.toLowerCase();
    if (lower.includes("fail") || lower.includes("reject") || lower.includes("error")) return "failed";
    if (lower.includes("process") || lower.includes("success")) return "success";
    if (lower.includes("pending")) return "pending";
  }

  if (status && typeof status === "object") {
    const keys = Object.keys(status).map((k) => k.toLowerCase());
    if (keys.some((k) => k.includes("fail") || k.includes("reject") || k.includes("error"))) return "failed";
    if (keys.some((k) => k.includes("process") || k.includes("success"))) return "success";
    if (keys.some((k) => k.includes("pending"))) return "pending";
  }

  if (tx?.block_height || tx?.confirmed_at) return "success";
  return "pending";
}

export function statusBadgeClass(status: TxStatus): string {
  if (status === "success" || status === "confirmed") return "badge-success";
  if (status === "failed") return "badge-failed";
  return "badge-pending";
}

export function statusLabel(status: TxStatus): string {
  return status.toUpperCase();
}
